<script setup lang="ts">
import type { SavedTwoFaAccount, TwoFaTask } from './api/modules/twofa'
import { Play, RefreshCcw, RotateCcw, Send, Square, Upload, X } from '@lucide/vue'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { controlTwoFaTask, getMigration, getSavedAccounts, getTwoFaScreen, getTwoFaStatus, getTwoFaTask, importMigration, reauthorizeTwoFaAccount, sendTwoFaInput, startTwoFaTask } from './api/modules/twofa'

const text = ref('')
const task = ref<TwoFaTask>()
const status = ref<{ ready: boolean, workerImageDigest: string, legacyVaultMounted: boolean }>()
const migration = ref<{ legacyVaultMounted: boolean, imported: boolean, marker?: { source: string, recordCount: number, updatedAt: string } }>()
const error = ref('')
const notice = ref('')
const screen = ref('')
const manualText = ref('')
const loading = ref(false)
const migrationLoading = ref(false)
const savedAccounts = ref<SavedTwoFaAccount[]>([])
const accountsLoading = ref(false)
const accountActionId = ref<string>()
let timer: ReturnType<typeof setTimeout> | undefined
let accountsTimer: ReturnType<typeof setTimeout> | undefined
let mounted = false

const labels: Record<string, string> = {
  queued: '排队中',
  starting: '启动登录',
  login: '填写邮箱',
  password: '验证密码',
  totp: '验证 2FA',
  consent: '确认授权',
  waiting: '等待人工验证',
  importing: '保存账号',
  succeeded: '导入成功',
  failed: '失败',
  cancelled: '已取消',
}

const accountStatusLabels: Record<string, string> = {
  normal: '正常',
  active: '正常',
  quota_exhausted: '配额耗尽',
  rate_limited: '限流中',
  error: '异常',
  disabled: '已停用',
  pending: '处理中',
}

const accountReasonLabels: Record<string, string> = {
  credential_invalid: '登录凭据失效',
  credential_expired: '登录凭据过期',
}

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : '操作失败'
}

async function refresh() {
  error.value = ''
  try {
    ;[status.value, migration.value] = await Promise.all([getTwoFaStatus(), getMigration()])
  }
  catch (cause) {
    error.value = message(cause)
  }
  await refreshAccounts()
}

function scheduleAccountsRefresh() {
  clearTimeout(accountsTimer)
  if (mounted)
    accountsTimer = setTimeout(() => void refreshAccounts(), 60_000)
}

async function refreshAccounts() {
  if (accountsLoading.value)
    return
  accountsLoading.value = true
  try {
    const result = await getSavedAccounts()
    if (!Array.isArray(result.items))
      throw new Error('插件返回了无效账号列表')
    savedAccounts.value = result.items
  }
  catch (cause) {
    error.value = message(cause)
  }
  finally {
    accountsLoading.value = false
    scheduleAccountsRefresh()
  }
}

async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file)
    return
  if (file.size > 131072) {
    error.value = 'TXT 文件须小于 128 KB'
    return
  }
  try {
    text.value = await file.text()
    error.value = ''
  }
  catch {
    error.value = '文件读取失败'
  }
}

async function start() {
  if (loading.value || task.value || !text.value.trim())
    return
  loading.value = true
  error.value = ''
  notice.value = ''
  try {
    task.value = await startTwoFaTask({
      text: text.value,
      submissionId: crypto.randomUUID(),
      settings: { enabled: true, concurrencyLimit: null, weight: 1, groupIds: [] },
    })
    text.value = ''
    schedule()
  }
  catch (cause) {
    error.value = message(cause)
  }
  finally {
    loading.value = false
  }
}

async function reauthorize(account: SavedTwoFaAccount) {
  if (!account.needsReauth || accountActionId.value || loading.value || task.value)
    return
  accountActionId.value = account.id
  error.value = ''
  notice.value = ''
  try {
    task.value = await reauthorizeTwoFaAccount(account.id, { submissionId: crypto.randomUUID() })
    screen.value = ''
    schedule()
    await refreshAccounts()
  }
  catch (cause) {
    error.value = message(cause)
  }
  finally {
    accountActionId.value = undefined
  }
}

function accountStatus(account: SavedTwoFaAccount) {
  return accountStatusLabels[account.status] || '未知'
}

function accountReason(account: SavedTwoFaAccount) {
  return account.errorReason ? accountReasonLabels[account.errorReason] : ''
}

function formatUpdatedAt(value?: string) {
  if (!value)
    return '暂无记录'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '暂无记录' : date.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
}

function schedule() {
  clearTimeout(timer)
  if (task.value)
    timer = setTimeout(() => void poll(), 1500)
}

async function poll() {
  if (!task.value)
    return
  try {
    const wasRunning = task.value.running
    task.value = await getTwoFaTask(task.value.id)
    const waiting = task.value.items.find(item => item.status === 'waiting')
    if (waiting) {
      const frame = await getTwoFaScreen(task.value.id, waiting.id)
      screen.value = frame.image
    }
    else {
      screen.value = ''
    }
    if (wasRunning && !task.value.running)
      await refreshAccounts()
    schedule()
  }
  catch (cause) {
    error.value = message(cause)
    clearTimeout(timer)
  }
}

async function control(action: 'cancel' | 'retry' | 'delete') {
  if (!task.value || loading.value)
    return
  loading.value = true
  try {
    if (action === 'delete') {
      await controlTwoFaTask(task.value.id, action)
      task.value = undefined
      screen.value = ''
    }
    else {
      task.value = await controlTwoFaTask(task.value.id, action)
      schedule()
    }
  }
  catch (cause) {
    error.value = message(cause)
  }
  finally {
    loading.value = false
  }
}

async function sendManual(kind: 'text' | 'key' | 'resume') {
  const waiting = task.value?.items.find(item => item.status === 'waiting')
  if (!task.value || !waiting || loading.value)
    return
  loading.value = true
  try {
    const data = kind === 'text' ? { kind, text: manualText.value } : kind === 'key' ? { kind, key: 'Enter' } : { kind }
    await sendTwoFaInput(task.value.id, waiting.id, data)
    manualText.value = ''
    screen.value = ''
    schedule()
  }
  catch (cause) {
    error.value = message(cause)
  }
  finally {
    loading.value = false
  }
}

async function migrate() {
  migrationLoading.value = true
  error.value = ''
  try {
    await importMigration()
    migration.value = await getMigration()
    notice.value = '迁移标记已确认，现有加密凭据继续由 companion Worker 使用'
  }
  catch (cause) {
    error.value = message(cause)
  }
  finally {
    migrationLoading.value = false
  }
}

onMounted(() => {
  mounted = true
  void refresh()
})
onBeforeUnmount(() => {
  mounted = false
  clearTimeout(timer)
  clearTimeout(accountsTimer)
})
</script>

<template>
  <main class="mx-auto flex min-w-0 max-w-5xl flex-col gap-4 p-4 font-sans text-cp-text">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-cp-xl font-semibold tracking-normal">
          批量 2FA 授权
        </h1>
        <p class="mt-1 text-cp-sm text-cp-text-secondary">
          批量导入 OpenAI OAuth 账号，必要时接管浏览器完成验证
        </p>
      </div>
      <button class="cp-button cp-button-secondary inline-flex items-center gap-2" type="button" :disabled="loading || migrationLoading || accountsLoading || !!accountActionId" @click="refresh">
        <RefreshCcw class="size-4" aria-hidden="true" />刷新状态
      </button>
    </header>

    <p v-if="error" class="rounded-cp bg-cp-danger-container px-3 py-2 text-cp-sm text-cp-danger-on-container" role="alert">
      {{ error }}
    </p>
    <p v-if="notice" class="rounded-cp bg-cp-success-container px-3 py-2 text-cp-sm text-cp-success-on-container">
      {{ notice }}
    </p>

    <section class="grid gap-3 md:grid-cols-3" aria-label="运行状态">
      <div class="rounded-cp border border-cp-outline-variant p-3">
        <div class="text-cp-xs text-cp-text-secondary">
          Worker
        </div>
        <div class="mt-1 font-medium">
          {{ status?.ready ? '就绪' : '不可用' }}
        </div>
      </div>
      <div class="rounded-cp border border-cp-outline-variant p-3">
        <div class="text-cp-xs text-cp-text-secondary">
          加密凭据
        </div>
        <div class="mt-1 font-medium">
          {{ status?.legacyVaultMounted ? '已挂载' : '未挂载' }}
        </div>
      </div>
      <div class="rounded-cp border border-cp-outline-variant p-3">
        <div class="text-cp-xs text-cp-text-secondary">
          迁移
        </div>
        <div class="mt-1 flex items-center justify-between gap-2 font-medium">
          <span>{{ migration?.imported ? '已确认' : '待确认' }}</span>
          <button v-if="!migration?.imported" class="cp-button cp-button-tertiary text-cp-xs" type="button" :disabled="migrationLoading" @click="migrate">
            确认迁移
          </button>
        </div>
      </div>
    </section>

    <section class="flex min-w-0 flex-col gap-3 rounded-cp border border-cp-outline-variant p-4" aria-labelledby="saved-accounts-title">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="saved-accounts-title" class="text-cp-lg font-medium">
            账号状态
          </h2>
          <p class="mt-1 text-cp-xs text-cp-text-secondary">
            仅显示 OpenAI OAuth 账号的安全摘要
          </p>
        </div>
        <button class="cp-button cp-button-secondary inline-flex items-center gap-2" type="button" :disabled="accountsLoading || !!accountActionId" @click="refreshAccounts">
          <RefreshCcw class="size-4" aria-hidden="true" />刷新账号
        </button>
      </div>
      <p v-if="accountsLoading && !savedAccounts.length" class="text-cp-sm text-cp-text-secondary">
        正在读取账号状态…
      </p>
      <p v-else-if="!savedAccounts.length" class="text-cp-sm text-cp-text-secondary">
        暂无账号状态
      </p>
      <div v-else class="overflow-x-auto rounded-cp border border-cp-outline-variant">
        <table class="w-full min-w-[42rem] text-left text-cp-sm">
          <thead class="border-b border-cp-outline-variant text-cp-xs text-cp-text-secondary">
            <tr>
              <th class="px-3 py-2 font-medium" scope="col">
                邮箱
              </th>
              <th class="px-3 py-2 font-medium" scope="col">
                状态
              </th>
              <th class="px-3 py-2 font-medium" scope="col">
                凭据
              </th>
              <th class="px-3 py-2 font-medium" scope="col">
                最近更新
              </th>
              <th class="px-3 py-2 text-right font-medium" scope="col">
                操作
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-cp-outline-variant">
            <tr v-for="account in savedAccounts" :key="account.id">
              <td class="max-w-[18rem] truncate px-3 py-2 font-medium" :title="account.email">
                {{ account.email }}
              </td>
              <td class="px-3 py-2">
                <span>{{ accountStatus(account) }}</span>
                <span v-if="accountReason(account)" class="mt-0.5 block text-cp-xs text-cp-danger">{{ accountReason(account) }}</span>
              </td>
              <td class="px-3 py-2 text-cp-text-secondary">
                {{ account.saved ? '已保存' : '未保存' }}
              </td>
              <td class="px-3 py-2 text-cp-text-secondary">
                {{ formatUpdatedAt(account.updatedAt) }}
              </td>
              <td class="px-3 py-2 text-right">
                <button v-if="account.needsReauth" class="cp-button cp-button-primary text-cp-xs" type="button" :disabled="!!accountActionId || loading || !!task" @click="reauthorize(account)">
                  {{ accountActionId === account.id ? '授权中…' : '一键重新授权' }}
                </button>
                <span v-else class="text-cp-xs text-cp-text-secondary">无需操作</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="flex min-w-0 flex-col gap-3 rounded-cp border border-cp-outline-variant p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-cp-lg font-medium">
          导入账号
        </h2>
        <label for="twofa-upload" class="cp-button cp-button-secondary inline-flex cursor-pointer items-center gap-2">
          <Upload class="size-4" aria-hidden="true" />上传 TXT
          <input id="twofa-upload" class="sr-only" type="file" accept=".txt,text/plain" @change="upload">
        </label>
      </div>
      <textarea id="twofa-text" v-model="text" aria-label="账号列表" class="min-h-40 w-full rounded-cp border border-cp-outline bg-cp-surface px-3 py-2 font-mono text-cp-sm outline-none focus:border-cp-primary" placeholder="每行：邮箱----密码----2FA密钥" :disabled="loading || !!task" />
      <div class="flex flex-wrap items-center justify-between gap-2 text-cp-xs text-cp-text-secondary">
        <span>最多 50 个账号；授权完成后只保存加密 2FA 信息</span>
        <button class="cp-button cp-button-primary inline-flex items-center gap-2" type="button" :disabled="loading || !!task || !text.trim()" @click="start">
          <Play class="size-4" aria-hidden="true" />开始授权登录
        </button>
      </div>
    </section>

    <section v-if="task" class="flex min-w-0 flex-col gap-3 rounded-cp border border-cp-outline-variant p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-cp-lg font-medium">
          授权任务
        </h2>
        <div class="flex flex-wrap gap-2">
          <button class="cp-button cp-button-secondary inline-flex items-center gap-2" type="button" :disabled="loading || task.running || task.cancelled" @click="control('retry')">
            <RotateCcw class="size-4" aria-hidden="true" />重试失败项
          </button>
          <button class="cp-button cp-button-secondary inline-flex items-center gap-2" type="button" :disabled="loading || !task.running" @click="control('cancel')">
            <Square class="size-4" aria-hidden="true" />取消任务
          </button>
          <button class="cp-button cp-button-tertiary inline-flex items-center gap-2" type="button" :disabled="loading || task.running" @click="control('delete')">
            <X class="size-4" aria-hidden="true" />关闭
          </button>
        </div>
      </div>
      <div class="divide-y divide-cp-outline-variant rounded-cp border border-cp-outline-variant">
        <div v-for="item in task.items" :key="item.id" class="flex flex-wrap items-center gap-3 px-3 py-2 text-cp-sm">
          <span class="min-w-0 flex-1 truncate">{{ item.email }}</span>
          <span class="text-cp-text-secondary">{{ labels[item.status] || item.status }}</span>
          <span v-if="item.message" class="basis-full text-cp-xs text-cp-danger">{{ item.message }}</span>
        </div>
      </div>
      <div v-if="screen" class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div class="overflow-hidden rounded-cp border border-cp-outline-variant bg-black">
          <img class="block max-h-[32rem] w-full object-contain" :src="screen" alt="等待人工验证的浏览器画面">
        </div>
        <div class="flex flex-col gap-2">
          <input v-model="manualText" class="w-full rounded-cp border border-cp-outline px-3 py-2 text-cp-sm" placeholder="输入验证码或文本" :disabled="loading">
          <button class="cp-button cp-button-primary inline-flex items-center justify-center gap-2" type="button" :disabled="loading || !manualText" @click="sendManual('text')">
            <Send class="size-4" aria-hidden="true" />发送文本
          </button>
          <button class="cp-button cp-button-secondary" type="button" :disabled="loading" @click="sendManual('key')">
            发送 Enter
          </button>
          <button class="cp-button cp-button-tertiary" type="button" :disabled="loading" @click="sendManual('resume')">
            继续自动流程
          </button>
        </div>
      </div>
    </section>
  </main>
</template>
