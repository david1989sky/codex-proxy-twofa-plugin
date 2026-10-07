<script setup lang="ts">
import type { SavedTwoFaAccount, TwoFaTask } from './api/modules/twofa'
import { LoaderCircle, Play, RefreshCcw, RotateCcw, Send, Square, Trash2, Upload, X } from '@lucide/vue'
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { controlTwoFaTask, deleteTwoFaAccount, getMigration, getSavedAccounts, getTwoFaScreen, getTwoFaStatus, getTwoFaTask, importMigration, reauthorizeTwoFaAccount, sendTwoFaInput, startTwoFaTask } from './api/modules/twofa'
import { imageClickToViewport } from './manual-input.mjs'
import { createRequestGate } from './operation.mjs'

const text = ref('')
const task = ref<TwoFaTask>()
const status = ref<{ ready: boolean, workerImageDigest: string, legacyVaultMounted: boolean }>()
const migration = ref<{ legacyVaultMounted: boolean, imported: boolean, marker?: { source: string, recordCount: number, updatedAt: string } }>()
const error = ref('')
const notice = ref('')
const screen = ref('')
const screenImage = ref<HTMLImageElement>()
const manualText = ref('')
const loading = ref(false)
const starting = ref(false)
const refreshing = ref(false)
const migrationLoading = ref(false)
const savedAccounts = ref<SavedTwoFaAccount[]>([])
const accountsLoading = ref(false)
const accountActionId = ref<string>()
const accountAction = ref<'reauthorize' | 'delete'>()
const pendingDelete = ref<SavedTwoFaAccount>()
const deleteDialog = ref<HTMLDialogElement>()
const accountsRequest = createRequestGate()
const statusRequest = createRequestGate()
const controlAction = ref<'cancel' | 'retry' | 'delete'>()
const manualAction = ref<'text' | 'key' | 'resume' | 'click'>()
let timer: ReturnType<typeof setTimeout> | undefined
let accountsTimer: ReturnType<typeof setTimeout> | undefined
let mounted = false
let taskEpoch = 0

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

function refresh() {
  return statusRequest.run(async () => {
    refreshing.value = true
    error.value = ''
    try {
      ;[status.value, migration.value] = await Promise.all([getTwoFaStatus(), getMigration()])
      await refreshAccounts()
    }
    catch (cause) {
      error.value = message(cause)
    }
    finally {
      refreshing.value = false
    }
  })
}

function scheduleAccountsRefresh() {
  clearTimeout(accountsTimer)
  if (mounted)
    accountsTimer = setTimeout(() => void refreshAccounts(), 60_000)
}

function refreshAccounts() {
  return accountsRequest.run(async () => {
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
  })
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
  if (loading.value || accountActionId.value || task.value || !text.value.trim())
    return
  loading.value = true
  starting.value = true
  error.value = ''
  notice.value = ''
  try {
    task.value = await startTwoFaTask({
      text: text.value,
      submissionId: crypto.randomUUID(),
      settings: { enabled: true, concurrencyLimit: null, weight: 1, groupIds: [] },
    })
    text.value = ''
    notice.value = '授权任务已启动'
    schedule()
  }
  catch (cause) {
    error.value = message(cause)
  }
  finally {
    loading.value = false
    starting.value = false
  }
}

async function reauthorize(account: SavedTwoFaAccount) {
  if (!account.saved || accountActionId.value || loading.value || task.value)
    return
  accountActionId.value = account.id
  accountAction.value = 'reauthorize'
  error.value = ''
  notice.value = ''
  try {
    task.value = await reauthorizeTwoFaAccount(account.id, { submissionId: crypto.randomUUID() })
    screen.value = ''
    notice.value = '已开始重新授权'
    schedule()
    await refreshAccounts()
  }
  catch (cause) {
    error.value = message(cause)
  }
  finally {
    accountActionId.value = undefined
    accountAction.value = undefined
  }
}

async function requestDelete(account: SavedTwoFaAccount) {
  if (accountActionId.value || loading.value || task.value)
    return
  pendingDelete.value = account
  await nextTick()
  deleteDialog.value?.showModal()
}

function cancelDelete() {
  deleteDialog.value?.close()
  pendingDelete.value = undefined
}

async function deleteAccount() {
  const account = pendingDelete.value
  if (!account || accountActionId.value || loading.value || task.value)
    return
  cancelDelete()
  accountActionId.value = account.id
  accountAction.value = 'delete'
  error.value = ''
  notice.value = ''
  try {
    await deleteTwoFaAccount(account.id)
    notice.value = '账号已删除'
    await refreshAccounts()
  }
  catch (cause) {
    error.value = message(cause)
  }
  finally {
    accountActionId.value = undefined
    accountAction.value = undefined
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
  if (mounted && task.value?.running)
    timer = setTimeout(() => void poll(), 1500)
}

async function poll() {
  if (!task.value)
    return
  const taskId = task.value.id
  const epoch = taskEpoch
  try {
    const wasRunning = task.value.running
    const updatedTask = await getTwoFaTask(taskId)
    if (!mounted || task.value?.id !== taskId || taskEpoch !== epoch)
      return
    task.value = updatedTask
    const waiting = task.value.items.find(item => item.status === 'waiting')
    if (waiting) {
      const frame = await getTwoFaScreen(task.value.id, waiting.id)
      if (!mounted || task.value?.id !== taskId || taskEpoch !== epoch)
        return
      screen.value = frame.image
    }
    else {
      screen.value = ''
    }
    if (wasRunning && !task.value.running) {
      notice.value = task.value.cancelled ? '授权任务已取消' : '授权任务已完成'
      await refreshAccounts()
    }
    schedule()
  }
  catch (cause) {
    if (!mounted || taskEpoch !== epoch)
      return
    error.value = message(cause)
    clearTimeout(timer)
  }
}

async function control(action: 'cancel' | 'retry' | 'delete') {
  if (!task.value || loading.value)
    return
  controlAction.value = action
  loading.value = true
  taskEpoch++
  clearTimeout(timer)
  error.value = ''
  try {
    if (action === 'delete') {
      await controlTwoFaTask(task.value.id, action)
      task.value = undefined
      screen.value = ''
    }
    else {
      task.value = await controlTwoFaTask(task.value.id, action)
      notice.value = action === 'retry' ? '已重新排队失败账号' : '授权任务已取消'
      schedule()
    }
  }
  catch (cause) {
    error.value = message(cause)
  }
  finally {
    loading.value = false
    controlAction.value = undefined
    schedule()
  }
}

type ManualInput = 'text' | 'key' | 'resume' | { kind: 'click', x: number, y: number }

async function sendManual(input: ManualInput) {
  const waiting = task.value?.items.find(item => item.status === 'waiting')
  if (!task.value || !waiting || loading.value)
    return
  manualAction.value = typeof input === 'string' ? input : input.kind
  loading.value = true
  error.value = ''
  taskEpoch++
  clearTimeout(timer)
  try {
    const data = typeof input === 'string'
      ? input === 'text' ? { kind: input, text: manualText.value } : input === 'key' ? { kind: input, key: 'Enter' } : { kind: input }
      : input
    await sendTwoFaInput(task.value.id, waiting.id, data)
    if (manualAction.value === 'text')
      manualText.value = ''
    if (manualAction.value === 'resume')
      screen.value = ''
    notice.value = '人工操作已发送'
    await poll()
  }
  catch (cause) {
    error.value = message(cause)
  }
  finally {
    loading.value = false
    manualAction.value = undefined
    schedule()
  }
}

function handleScreenClick(event: MouseEvent) {
  const input = imageClickToViewport(event, screenImage.value)
  if (input)
    void sendManual(input)
}

async function migrate() {
  if (migrationLoading.value)
    return
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
  taskEpoch++
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
      <button class="cp-button cp-button-secondary cp-action inline-flex items-center gap-2" type="button" :disabled="refreshing || loading || migrationLoading || accountsLoading || !!accountActionId" :aria-busy="refreshing" @click="refresh">
        <LoaderCircle v-if="refreshing" class="size-4 cp-spin" aria-hidden="true" />
        <RefreshCcw v-else class="size-4" aria-hidden="true" />{{ refreshing ? '刷新中…' : '刷新状态' }}
      </button>
    </header>

    <Transition name="cp-fade" mode="out-in">
      <p v-if="error" :key="`error-${error}`" class="rounded-cp bg-cp-danger-container px-3 py-2 text-cp-sm text-cp-danger-on-container" role="alert">
        {{ error }}
      </p>
    </Transition>
    <Transition name="cp-fade" mode="out-in">
      <p v-if="notice" :key="`notice-${notice}`" class="rounded-cp bg-cp-success-container px-3 py-2 text-cp-sm text-cp-success-on-container" aria-live="polite">
        {{ notice }}
      </p>
    </Transition>

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
        <button class="cp-button cp-button-secondary cp-action inline-flex items-center gap-2" type="button" :disabled="accountsLoading || !!accountActionId" :aria-busy="accountsLoading" @click="refreshAccounts">
          <LoaderCircle v-if="accountsLoading" class="size-4 cp-spin" aria-hidden="true" />
          <RefreshCcw v-else class="size-4" aria-hidden="true" />
          {{ accountsLoading ? '刷新中…' : '刷新账号' }}
        </button>
      </div>
      <Transition name="cp-fade" mode="out-in">
        <p v-if="accountsLoading && !savedAccounts.length" key="accounts-loading" class="text-cp-sm text-cp-text-secondary" aria-live="polite">
          正在读取账号状态…
        </p>
        <p v-else-if="!savedAccounts.length" key="accounts-empty" class="text-cp-sm text-cp-text-secondary">
          暂无账号状态
        </p>
        <div v-else key="accounts-table" class="overflow-x-auto rounded-cp border border-cp-outline-variant" :aria-busy="accountsLoading">
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
                  <div class="inline-flex items-center justify-end gap-1">
                    <button v-if="account.saved" class="cp-button cp-button-primary size-8 shrink-0 justify-center p-0" type="button" :disabled="!!accountActionId || loading || !!task" :aria-label="accountActionId === account.id && accountAction === 'reauthorize' ? '授权中' : '重新授权'" :title="accountActionId === account.id && accountAction === 'reauthorize' ? '授权中' : '重新授权'" @click="reauthorize(account)">
                      <LoaderCircle v-if="accountActionId === account.id && accountAction === 'reauthorize'" class="size-3.5 cp-spin" aria-hidden="true" />
                      <RotateCcw v-else class="size-3.5" aria-hidden="true" />
                    </button>
                    <button class="cp-button cp-button-tertiary size-8 shrink-0 justify-center p-0 text-cp-danger" type="button" :disabled="!!accountActionId || loading || !!task" :aria-label="accountActionId === account.id && accountAction === 'delete' ? '删除中' : '删除账号'" :title="accountActionId === account.id && accountAction === 'delete' ? '删除中' : '删除账号'" @click="requestDelete(account)">
                      <LoaderCircle v-if="accountActionId === account.id && accountAction === 'delete'" class="size-3.5 cp-spin" aria-hidden="true" />
                      <Trash2 v-else class="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Transition>
    </section>

    <dialog ref="deleteDialog" class="w-[min(24rem,calc(100vw-2rem))] rounded-cp border border-cp-outline-variant bg-cp-surface p-4 text-cp-text backdrop:bg-black/50" aria-labelledby="delete-account-title" aria-describedby="delete-account-description" @cancel="pendingDelete = undefined">
      <h2 id="delete-account-title" class="text-cp-lg font-medium">
        删除账号
      </h2>
      <p id="delete-account-description" class="mt-2 break-all text-cp-sm text-cp-text-secondary">
        永久删除 {{ pendingDelete?.email }} 的 RS 账号及已保存 2FA 信息？
      </p>
      <div class="mt-4 flex justify-end gap-2">
        <button class="cp-button cp-button-secondary" type="button" @click="cancelDelete">
          取消
        </button>
        <button class="cp-button cp-button-tertiary text-cp-danger" type="button" @click="deleteAccount">
          删除
        </button>
      </div>
    </dialog>

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
      <textarea id="twofa-text" v-model="text" aria-label="账号列表" class="min-h-40 w-full rounded-cp border border-cp-outline bg-cp-surface px-3 py-2 font-mono text-cp-sm outline-none focus:border-cp-primary" placeholder="每行：邮箱----密码----2FA密钥" :disabled="loading || !!accountActionId || !!task" />
      <div class="flex flex-wrap items-center justify-between gap-2 text-cp-xs text-cp-text-secondary">
        <span>最多 50 个账号；授权完成后只保存加密 2FA 信息</span>
        <button class="cp-button cp-button-primary cp-action-start inline-flex items-center gap-2" type="button" :disabled="loading || !!accountActionId || !!task || !text.trim()" :aria-busy="starting" @click="start">
          <LoaderCircle v-if="starting" class="size-4 cp-spin" aria-hidden="true" />
          <Play v-else class="size-4" aria-hidden="true" />
          {{ starting ? '启动中…' : '开始授权登录' }}
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
            <LoaderCircle v-if="controlAction === 'retry'" class="size-4 cp-spin" aria-hidden="true" />
            <RotateCcw v-else class="size-4" aria-hidden="true" />{{ controlAction === 'retry' ? '重新排队中…' : '重试失败项' }}
          </button>
          <button class="cp-button cp-button-secondary inline-flex items-center gap-2" type="button" :disabled="loading || !task.running" @click="control('cancel')">
            <LoaderCircle v-if="controlAction === 'cancel'" class="size-4 cp-spin" aria-hidden="true" />
            <Square v-else class="size-4" aria-hidden="true" />{{ controlAction === 'cancel' ? '取消中…' : '取消任务' }}
          </button>
          <button class="cp-button cp-button-tertiary inline-flex items-center gap-2" type="button" :disabled="loading || task.running" @click="control('delete')">
            <X class="size-4" aria-hidden="true" />关闭
          </button>
        </div>
      </div>
      <TransitionGroup name="cp-list" tag="div" class="divide-y divide-cp-outline-variant rounded-cp border border-cp-outline-variant">
        <div v-for="item in task.items" :key="item.id" class="flex flex-wrap items-center gap-3 px-3 py-2 text-cp-sm">
          <span class="min-w-0 flex-1 truncate">{{ item.email }}</span>
          <span :key="item.status" class="cp-stage text-cp-text-secondary" aria-live="polite">{{ labels[item.status] || item.status }}</span>
          <span v-if="item.message" class="basis-full text-cp-xs text-cp-danger">{{ item.message }}</span>
        </div>
      </TransitionGroup>
      <div v-if="screen" class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div class="overflow-hidden rounded-cp border border-cp-outline-variant bg-black">
          <button class="block w-full cursor-crosshair appearance-none border-0 bg-transparent p-0 text-left disabled:cursor-wait" type="button" :disabled="loading" title="点击浏览器画面进行人工验证" @click="handleScreenClick">
            <img ref="screenImage" class="cp-screen block max-h-[32rem] w-full select-none object-contain" :class="{ 'cp-screen-visible': screen }" :src="screen" alt="等待人工验证的浏览器画面" draggable="false">
          </button>
        </div>
        <div class="flex flex-col gap-2">
          <input v-model="manualText" class="w-full rounded-cp border border-cp-outline px-3 py-2 text-cp-sm" placeholder="输入验证码或文本" :disabled="loading">
          <button class="cp-button cp-button-primary inline-flex items-center justify-center gap-2" type="button" :disabled="loading || !manualText" :aria-busy="manualAction === 'text'" @click="sendManual('text')">
            <LoaderCircle v-if="manualAction === 'text'" class="size-4 cp-spin" aria-hidden="true" />
            <Send v-else class="size-4" aria-hidden="true" />{{ manualAction === 'text' ? '发送中…' : '发送文本' }}
          </button>
          <button class="cp-button cp-button-secondary inline-flex items-center justify-center gap-2" type="button" :disabled="loading" :aria-busy="manualAction === 'key'" @click="sendManual('key')">
            <LoaderCircle v-if="manualAction === 'key'" class="size-4 cp-spin" aria-hidden="true" />{{ manualAction === 'key' ? '发送中…' : '发送 Enter' }}
          </button>
          <button class="cp-button cp-button-tertiary inline-flex items-center justify-center gap-2" type="button" :disabled="loading" :aria-busy="manualAction === 'resume'" @click="sendManual('resume')">
            <LoaderCircle v-if="manualAction === 'resume'" class="size-4 cp-spin" aria-hidden="true" />{{ manualAction === 'resume' ? '继续中…' : '继续自动流程' }}
          </button>
        </div>
      </div>
    </section>
  </main>
</template>
