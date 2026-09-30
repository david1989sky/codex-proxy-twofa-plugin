# 已保存账号一键重新授权设计

## 目标

上传并成功授权的 OpenAI OAuth 账号继续把邮箱、密码和 2FA 信息保存在现有 AES-256-GCM 凭据库中。插件页自动读取 RS 的账号状态；当账号因 `credential_invalid` 或 `credential_expired` 进入错误状态，且本地存在对应加密凭据时，显示一键重新授权入口。

## 范围与不变项

- 复用现有 Worker vault、`reauthorize` 路由和浏览器授权流程，不新增明文凭据存储。
- 只处理 OpenAI OAuth 账号；API Key、xAI、停用账号和配额/限流状态不显示重新授权按钮。
- 页面只展示邮箱、账号状态、错误原因摘要、凭据是否已保存和最近检查时间，不返回密码、TOTP、Provider 文档或原始错误内容。
- 不修改 RS 核心账号列表页面；账号发现和操作都在插件页完成。

## 数据流

1. 插件页面调用 `GET api/accounts`。
2. Rust 管理路由将请求转发到 Worker 的 `/api/admin/twofa/accounts`。
3. Worker 使用当前管理员会话调用 RS `/api/admin/accounts`，分页读取 OpenAI OAuth 账号摘要，并逐个检查 vault 是否存在对应加密记录。
4. Worker 仅返回安全投影：`id`、`email`、`status`、`errorReason`、`saved`、`needsReauth` 和 `updatedAt`。
5. 页面首次挂载、手动刷新以及每 60 秒自动刷新账号状态。轮询失败显示错误但保留上一次列表。
6. 点击“一键重新授权”时复用现有 `POST api/request` 的 `reauthorize` 操作，生成新的幂等 `submissionId`，把返回任务交给现有任务面板；任务完成后刷新账号列表。

## 状态规则

`needsReauth` 仅在 `saved === true` 且 `status === "error"` 且 `errorReason` 为 `credential_invalid` 或 `credential_expired` 时为真。其余状态只显示状态信息，不提供重新授权动作，避免把封禁、停用、配额和限流误判为登录失效。

## 错误与并发

- 同一账号已有授权任务时，Worker 返回现有冲突错误，页面保留当前任务并禁止重复点击。
- 重新授权请求失败时不清除 vault，不修改 RS 账号设置，并在页面显示稳定的错误消息。
- 账号列表接口不得把 RS `errorMessage` 原文或任何凭据字段写入响应、日志或前端状态。

## 验证

- Worker API 测试覆盖分页摘要、凭据存在性投影、401 对应错误原因和不泄露凭据。
- Rust 路由测试覆盖 `api/accounts` 转发和路径白名单。
- 前端 E2E 测试覆盖列表轮询、401 行出现按钮、点击后创建重新授权任务、非 401 状态无按钮以及轮询失败保留旧列表。
- 生产验证只使用虚构账号；确认页面状态、任务创建/取消和凭据目录没有新增或修改文件。
