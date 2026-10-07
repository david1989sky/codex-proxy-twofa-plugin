import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const compose = fileURLToPath(new URL('../ops/compose.yaml', import.meta.url))
const update = fileURLToPath(new URL('../../ops/companion-update.sh', import.meta.url))

test('worker uses a stable private network and RS service address', t => {
  const command = spawnSync('docker', ['compose', '-f', compose, 'config', '--format', 'json'], {
    env: {
      ...process.env,
      WORKER_IMAGE: 'ghcr.io/example/worker@sha256:' + 'a'.repeat(64),
      PUBLIC_ORIGIN: 'https://example.com',
      CPR_TWOFA_RS_NETWORK: 'codex-proxy-rs-v380_default',
    },
    encoding: 'utf8',
  })
  if (command.error?.code === 'ENOENT') return t.skip('docker compose is unavailable')
  assert.equal(command.status, 0, command.stderr)
  const config = JSON.parse(command.stdout)
  assert.equal(config.services.worker.network_mode, undefined)
  assert.deepEqual(config.services.worker.networks.rs.aliases, ['cpr-twofa-worker'])
  assert.equal(config.networks.rs.external, true)
  assert.equal(config.networks.rs.name, 'codex-proxy-rs-v380_default')
  assert.equal(config.services.worker.environment.CPR_BASE_URL, 'http://codex-proxy-rs:8080')
  assert.equal(config.services.worker.environment.WORKER_LISTEN_HOST, '0.0.0.0')
  assert.equal(config.services.worker.ports, undefined)
})

function releaseFixture(base, version) {
  const source = join(base, version)
  mkdirSync(join(source, 'ops'), { recursive: true })
  for (const name of ['Dockerfile', 'entrypoint.sh', 'package.json', 'package-lock.json']) {
    writeFileSync(join(source, name), version)
  }
  writeFileSync(join(source, 'ops', 'compose.yaml'), version)
  writeFileSync(join(source, 'ops', 'provision-vault.sh'), '#!/usr/bin/env bash\n')
  writeFileSync(join(source, 'ops', 'deploy.sh'), `#!/usr/bin/env bash
set -euo pipefail
[[ "\${FAIL_DEPLOY:-}" != 1 ]] || exit 7
backup="$CPR_TWOFA_ROOT/backup/twofa-worker"
mkdir -p "$backup"
[[ ! -f "$backup/current-image" ]] || cp "$backup/current-image" "$backup/previous-image"
printf '%s\\n' "$WORKER_IMAGE" > "$backup/current-image"
printf '%s\\n' "$PUBLIC_ORIGIN" > "$backup/current-origin"
printf '%s\\n' "$CPR_TWOFA_COMPOSE" > "$CPR_TWOFA_ROOT/deploy-compose"
`)
  writeFileSync(join(source, 'ops', 'rollback.sh'), `#!/usr/bin/env bash
set -euo pipefail
[[ "\${FAIL_ROLLBACK:-}" != 1 ]] || exit 8
backup="$CPR_TWOFA_ROOT/backup/twofa-worker"
printf '%s\\n' "$CPR_TWOFA_COMPOSE" > "$CPR_TWOFA_ROOT/rollback-compose"
cp "$backup/previous-image" "$backup/current-image"
`)
  return source
}

function upgradeFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cpr-twofa-upgrade-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const active = join(root, 'release', 'codex-proxy-twofa-worker')
  const oldSource = releaseFixture(root, 'old')
  const newSource = releaseFixture(root, 'new')
  mkdirSync(join(root, 'release'), { recursive: true })
  cpSync(oldSource, active, { recursive: true })
  const backup = join(root, 'backup', 'twofa-worker')
  mkdirSync(backup, { recursive: true })
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CPR_TWOFA_ROOT/systemctl-log"
case "$1" in
  is-enabled) [[ -f "$CPR_TWOFA_ROOT/timer-enabled" ]] ;;
  is-active) [[ -f "$CPR_TWOFA_ROOT/timer-active" ]] ;;
  disable) rm -f "$CPR_TWOFA_ROOT/timer-enabled" "$CPR_TWOFA_ROOT/timer-active" ;;
  enable) touch "$CPR_TWOFA_ROOT/timer-enabled"; [[ "\${2:-}" != --now ]] || touch "$CPR_TWOFA_ROOT/timer-active" ;;
  start) touch "$CPR_TWOFA_ROOT/timer-active" ;;
  stop) rm -f "$CPR_TWOFA_ROOT/timer-active" ;;
esac
`, { mode: 0o755 })
  const oldImage = `ghcr.io/example/worker@sha256:${'a'.repeat(64)}`
  const newImage = `ghcr.io/example/worker@sha256:${'b'.repeat(64)}`
  const earlierImage = `ghcr.io/example/worker@sha256:${'c'.repeat(64)}`
  writeFileSync(join(backup, 'current-image'), `${oldImage}\n`)
  writeFileSync(join(backup, 'previous-image'), `${earlierImage}\n`)
  writeFileSync(join(backup, 'current-origin'), 'https://old.example\n')
  return { root, active, backup, bin, oldImage, newImage, earlierImage, newSource }
}

function runUpdate(fixture, args = [], extraEnv = {}) {
  return spawnSync('bash', [update, ...args], {
    env: {
      ...process.env,
      CPR_TWOFA_ROOT: fixture.root,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      WORKER_SOURCE_DIR: fixture.newSource,
      WORKER_IMAGE: fixture.newImage,
      PUBLIC_ORIGIN: 'https://new.example',
      ...extraEnv,
    },
    encoding: 'utf8',
  })
}

test('failed upgrade restores the prior worker using its prior compose', t => {
  const fixture = upgradeFixture(t)
  const result = runUpdate(fixture, [], { FAIL_DEPLOY: '1' })
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(join(fixture.active, 'ops', 'compose.yaml'), 'utf8'), 'old')
  assert.equal(readFileSync(join(fixture.root, 'rollback-compose'), 'utf8').trim(), join(fixture.active, 'ops', 'compose.yaml'))
  assert.equal(readFileSync(join(fixture.backup, 'current-image'), 'utf8').trim(), fixture.oldImage)
  assert.equal(readFileSync(join(fixture.backup, 'previous-image'), 'utf8').trim(), fixture.earlierImage)
  assert.equal(existsSync(join(fixture.backup, 'previous-release-path')), false)
})

test('successful upgrade retains the prior release for explicit rollback', t => {
  const fixture = upgradeFixture(t)
  const result = runUpdate(fixture)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(join(fixture.active, 'ops', 'compose.yaml'), 'utf8'), 'new')
  const snapshot = readFileSync(join(fixture.backup, 'previous-release-path'), 'utf8').trim()
  assert.equal(readFileSync(join(snapshot, 'ops', 'compose.yaml'), 'utf8'), 'old')

  const rollback = runUpdate(fixture, ['--rollback'])
  assert.equal(rollback.status, 0, rollback.stderr)
  assert.equal(readFileSync(join(fixture.root, 'rollback-compose'), 'utf8').trim(), join(snapshot, 'ops', 'compose.yaml'))
  assert.equal(readFileSync(join(fixture.active, 'ops', 'compose.yaml'), 'utf8'), 'old')
  assert.equal(readFileSync(join(fixture.backup, 'current-image'), 'utf8').trim(), fixture.oldImage)
  assert.equal(readFileSync(join(fixture.backup, 'previous-image'), 'utf8').trim(), fixture.earlierImage)
  assert.equal(existsSync(join(fixture.backup, 'previous-release-path')), false)
})

test('failed explicit rollback restores the current worker and keeps its snapshot', t => {
  const fixture = upgradeFixture(t)
  assert.equal(runUpdate(fixture).status, 0)
  const snapshot = readFileSync(join(fixture.backup, 'previous-release-path'), 'utf8').trim()
  const result = runUpdate(fixture, ['--rollback'], { FAIL_ROLLBACK: '1' })
  assert.notEqual(result.status, 0)
  assert.equal(readFileSync(join(fixture.active, 'ops', 'compose.yaml'), 'utf8'), 'new')
  assert.equal(readFileSync(join(fixture.backup, 'current-image'), 'utf8').trim(), fixture.newImage)
  assert.equal(readFileSync(join(fixture.backup, 'previous-release-path'), 'utf8').trim(), snapshot)
})

test('failed upgrade restores the legacy rebind timer state', t => {
  const fixture = upgradeFixture(t)
  writeFileSync(join(fixture.root, 'timer-enabled'), '')
  writeFileSync(join(fixture.root, 'timer-active'), '')
  const result = runUpdate(fixture, [], { FAIL_DEPLOY: '1' })
  assert.notEqual(result.status, 0)
  assert.equal(existsSync(join(fixture.root, 'timer-enabled')), true)
  assert.equal(existsSync(join(fixture.root, 'timer-active')), true)
  assert.match(readFileSync(join(fixture.root, 'systemctl-log'), 'utf8'), /disable --now cpr-twofa-rebind-worker.timer/)
})

test('successful upgrade disables the legacy rebind timer', t => {
  const fixture = upgradeFixture(t)
  writeFileSync(join(fixture.root, 'timer-enabled'), '')
  writeFileSync(join(fixture.root, 'timer-active'), '')
  const result = runUpdate(fixture)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(existsSync(join(fixture.root, 'timer-enabled')), false)
  assert.equal(existsSync(join(fixture.root, 'timer-active')), false)

  const rollback = runUpdate(fixture, ['--rollback'])
  assert.equal(rollback.status, 0, rollback.stderr)
  assert.equal(existsSync(join(fixture.root, 'timer-enabled')), true)
  assert.equal(existsSync(join(fixture.root, 'timer-active')), true)
})

test('preflight failure leaves a still-running prior container untouched', t => {
  const fixture = upgradeFixture(t)
  writeFileSync(join(fixture.bin, 'docker'), `#!/usr/bin/env bash
[[ "$1" == inspect ]] || exit 1
[[ "$4" == cpr-twofa-worker ]] || exit 1
case "$3" in
  '{{.Id}}') printf '%s\\n' prior-container ;;
  '{{.State.Running}}') printf '%s\\n' true ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 })
  const result = runUpdate(fixture, [], { FAIL_DEPLOY: '1' })
  assert.notEqual(result.status, 0)
  assert.equal(existsSync(join(fixture.root, 'rollback-compose')), false)
  assert.equal(readFileSync(join(fixture.backup, 'previous-image'), 'utf8').trim(), fixture.earlierImage)
})
