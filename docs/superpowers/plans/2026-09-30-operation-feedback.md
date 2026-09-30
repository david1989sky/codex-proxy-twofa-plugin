# 授权操作稳定性与交互反馈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 减少 2FA 授权和账号刷新中的重复请求与过快阶段切换，并为主要操作提供清晰、可访问的交互动画。

**Architecture:** Vue 页面通过 Promise 合并和操作锁保证一次用户意图只发起一次请求；状态变化用现有 CSS/Lucide 体系表达，且在 `prefers-reduced-motion` 下自动降级。Worker 在任务重试和浏览器阶段之间使用固定冷却时间，让页面状态有时间稳定下来；人工验证仍保持人工接管，Worker 不处理 CAPTCHA。

**Tech Stack:** Vue 3 + TypeScript + Tailwind CSS、Node.js 22、Playwright、Node test runner。

**Verified implementation (2026-09-30):** 前端请求合并与操作反馈、Worker 冷却、综合本地验证均已完成。账号表、任务行和截图保持稳定节点；阶段文本单独淡入，避免列表 revision 和截图替换导致滚动或点击丢失。实际 UI 回归位于 `worker/test/plugin-ui.e2e.mjs`。GET 重试最多三次，共享 15 秒总预算、单次最多 5 秒，POST 不重放。Worker 48/48、前端 3/3、插件 UI E2E 5/5、Rust 7/7、lint/build、fmt/clippy 和 diff 检查通过。版本更新为 0.1.9，发布和生产验证在本地验证后执行。

---

### Task 1: 前端请求去重与操作反馈

**Files:**
- Modify: `frontend/src/App.vue`
- Modify: `frontend/src/styles/index.css`
- Test: `worker/test/ui.e2e.mjs`

- [ ] **Step 1: Add request coalescing and visible action state**

在 `App.vue` 增加 `accountsRequest` 和 `actionNotice`，让 `refreshAccounts()` 返回当前进行中的 Promise；`start()`、`control()`、`sendManual()` 成功后设置短文本提示，并在 finally 中只释放自己的 loading 状态。刷新账号时只有成功响应才替换 `savedAccounts`，失败继续显示上一次列表。

- [ ] **Step 2: Add animated controls and state transitions**

引入 `LoaderCircle` 图标；开始授权、刷新账号、重新授权、重试、取消和人工输入按钮在忙碌时显示旋转图标与动作文本。告警和首次出现的状态淡入；账号表、任务行和人工验证截图保持稳定节点，任务阶段文本单独淡入。

- [ ] **Step 3: Add reduced-motion CSS**

在 `styles/index.css` 加入 `.cp-spin`、`.cp-fade-*`、`.cp-list-*` 和 `.cp-screen-*` 过渡，并在 `@media (prefers-reduced-motion: reduce)` 中将动画时长降为 `1ms`、取消位移和无限旋转。

- [ ] **Step 4: Extend the UI fixture assertions**

在 UI E2E 中对“刷新账号”同时触发两次的场景计数，断言后端只收到一次请求；点击“开始授权登录”后断言按钮显示忙碌文案并在任务返回后恢复；断言 `prefers-reduced-motion` 页面没有页面错误。

- [ ] **Step 5: Run frontend verification**

运行 `pnpm typecheck`、`pnpm lint` 和 `pnpm build`（工作目录 `frontend`），确认 Vue 模板、类型和 CSS 均通过。

- [ ] **Step 6: Commit**

运行：

```bash
git add frontend/src/App.vue frontend/src/styles/index.css worker/test/ui.e2e.mjs
git commit -m "feat: add idempotent operation feedback"
```

### Task 2: Worker 任务冷却与阶段稳定性

**Files:**
- Modify: `worker/src/core.mjs`
- Modify: `worker/src/browser.mjs`
- Test: `worker/test/core.test.mjs`
- Test: `worker/test/browser.test.mjs`

- [ ] **Step 1: Write failing tests for retry and stage cooldown**

在 `core.test.mjs` 增加带 `retryDelayMs: 20` 的 `Jobs` fixture：第一次运行失败，调用 `retry()` 后立即断言第二次运行尚未开始，等待至少 20ms 后再断言第二次运行开始。使用 `t.after` 关闭 Job。 在 `browser.test.mjs` 的 fake page 记录 `button.click()` 与下一次阶段检查之间的时间，断言默认冷却不小于 350ms。

- [ ] **Step 2: Run focused tests and confirm failure**

运行 `npm test -- --test-name-pattern="retry cooldown|stage cooldown"`（工作目录 `worker`），预期新增断言失败，因为当前 retry 立即启动、浏览器点击后只等待 200ms。

- [ ] **Step 3: Implement bounded retry cooldown**

从 `node:timers/promises` 引入 `setTimeout`，将 `Jobs` 构造参数扩展为 `retryDelayMs = 750`，`retry()` 调用 `#start(job, retryDelayMs)`；`#start` 在循环前使用可取消的 `delay(retryDelayMs, undefined, { signal })`，取消时不遗留定时器。冷却只作用于手动 retry，不增加成功任务的额外等待。

- [ ] **Step 4: Implement browser stage settle delay**

在 `browser.mjs` 定义 `stageSettleMs = 350`，成功点击提交后等待 `delay(stageSettleMs, undefined, { signal })`；保留现有 `lastAction` 去重和 20 秒人工接管条件，不增加自动点击次数，也不改变 CAPTCHA 分流。

- [ ] **Step 5: Run Worker verification**

运行 `npm test`（工作目录 `worker`），确认 core、browser、API、vault 和 UI 测试全部通过。

- [ ] **Step 6: Commit**

运行：

```bash
git add worker/src/core.mjs worker/src/browser.mjs worker/test/core.test.mjs worker/test/browser.test.mjs
git commit -m "fix: settle authorization retries and browser stages"
```

### Task 3: 综合验证与发布准备

**Files:**
- No source changes expected; only update release notes if the repository requires them.

- [ ] **Step 1: Run complete local checks**

运行 Worker `npm test`，前端 `pnpm typecheck && pnpm lint && pnpm build`，并检查 `git diff --check`。

- [ ] **Step 2: Inspect the built UI**

使用现有 UI E2E 的桌面和移动视口截图，确认开始授权、刷新账号、任务状态和人工验证画面没有布局重叠；在 reduced-motion 视口确认只保留状态颜色和文本变化。

- [ ] **Step 3: Verify safety boundaries**

确认 diff 中没有新增凭据日志、CAPTCHA 自动处理、无限重试、外部请求地址或生产密钥；确认人工验证输入端点和已有点击坐标映射未被改写。

- [ ] **Step 4: Commit any required release metadata**

仅在仓库现有发布检查要求时更新版本或说明；用 `git status --short --branch` 确认工作区只包含本次改动。
