import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export async function openVault({ directory, keyFile }) {
  const key = await readFile(keyFile)
  if (key.length !== 32) throw new Error('Credential vault requires a 32-byte key')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const pathFor = id => join(directory, `${createHash('sha256').update(id).digest('hex')}.json`)
  const pendingPathFor = id => join(directory, `.pending-delete-${createHash('sha256').update(id).digest('hex')}.json`)
  const recordLocks = new Map()
  function encrypt(id, value) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(`cpr-twofa-v1:${id}`))
    const plaintext = Buffer.from(JSON.stringify(value))
    try {
      const data = Buffer.concat([cipher.update(plaintext), cipher.final()])
      return JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') })
    } finally { plaintext.fill(0) }
  }
  function decrypt(id, text) {
    const record = JSON.parse(text)
    if (record.version !== 1) throw new Error('Unsupported credential vault format')
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'))
    decipher.setAAD(Buffer.from(`cpr-twofa-v1:${id}`))
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(record.data, 'base64')), decipher.final()])
    try { return JSON.parse(plaintext.toString()) } finally { plaintext.fill(0) }
  }
  async function atomicWrite(path, contents) {
    const temp = `${path}.${randomUUID()}.tmp`
    try {
      const file = await open(temp, 'wx', 0o600)
      try { await file.writeFile(contents); await file.sync() } finally { await file.close() }
      await rename(temp, path)
      const dir = await open(directory, 'r')
      try { await dir.sync() } finally { await dir.close() }
    } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
  }
  async function writeRecord(id, record) {
    await atomicWrite(pathFor(id), encrypt(id, record))
  }
  function withRecordLock(id, action) {
    const previous = recordLocks.get(id) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(action)
    recordLocks.set(id, current)
    return current.finally(() => {
      if (recordLocks.get(id) === current) recordLocks.delete(id)
    })
  }
  // 密钥由部署单独提供，已有数据时绝不自动生成或替换密钥。
  const checkFile = join(directory, '.key-check')
  try {
    if (decrypt('key-check', await readFile(checkFile, 'utf8')) !== 'cpr-twofa-v1') throw new Error('Invalid vault key')
  } catch (error) {
    if (error.code !== 'ENOENT' || (await readdir(directory)).length) throw new Error('Credential vault key validation failed')
    await atomicWrite(checkFile, encrypt('key-check', 'cpr-twofa-v1'))
  }
  return {
    async markPendingDelete(id) {
      if (!id) throw new Error('Missing account ID')
      await atomicWrite(pendingPathFor(id), encrypt('pending-delete', { id }))
    },
    async pendingDeletions() {
      const ids = []
      for (const file of await readdir(directory)) {
        if (!/^\.pending-delete-[a-f0-9]{64}\.json$/.test(file)) continue
        const record = decrypt('pending-delete', await readFile(join(directory, file), 'utf8'))
        if (typeof record?.id !== 'string' || pendingPathFor(record.id) !== join(directory, file))
          throw new Error('Invalid pending deletion record')
        ids.push(record.id)
      }
      return ids
    },
    async clearPendingDelete(id) {
      await unlink(pendingPathFor(id)).catch(error => { if (error.code !== 'ENOENT') throw error })
    },
    async put(id, credentials) {
      if (!id || !credentials.email || !credentials.password || !credentials.totpSecret) throw new Error('Incomplete vault record')
      await withRecordLock(id, () => writeRecord(id, { credentials, updatedAt: new Date().toISOString() }))
    },
    async markFailure(id, reason) {
      if (!id || reason !== 'credential_invalid') throw new Error('Invalid credential failure record')
      return withRecordLock(id, async () => {
        const record = await this.get(id)
        if (!record) return false
        await writeRecord(id, { ...record, reauthFailure: { reason, updatedAt: new Date().toISOString() } })
        return true
      })
    },
    async clearFailure(id) {
      return withRecordLock(id, async () => {
        const record = await this.get(id)
        if (!record?.reauthFailure) return false
        delete record.reauthFailure
        await writeRecord(id, record)
        return true
      })
    },
    async get(id) {
      try { return decrypt(id, await readFile(pathFor(id), 'utf8')) }
      catch (error) { if (error.code === 'ENOENT') return null; throw error }
    },
    async delete(id) {
      await withRecordLock(id, () => unlink(pathFor(id)).catch(error => { if (error.code !== 'ENOENT') throw error }))
    },
  }
}
