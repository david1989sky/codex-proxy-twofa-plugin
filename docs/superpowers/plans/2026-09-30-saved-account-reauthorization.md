# Saved Account Reauthorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show saved OpenAI OAuth accounts in the 2FA plugin and offer one-click reauthorization only when RS reports an expired or invalid credential.

**Architecture:** The Worker will page through RS account summaries, join them with the encrypted vault by account id, and return a minimal credential-free projection. The Rust management bridge will expose that Worker endpoint as `GET api/accounts`; Vue will poll it every 60 seconds and reuse the existing `reauthorize` operation to create the task shown by the current task panel.

**Tech Stack:** Node.js 22, Fastify, Node test runner, AES-256-GCM vault, Rust 2024 with reqwest/serde, Vue 3 + TypeScript + Vite.

---

### Task 1: Worker account summary endpoint

**Files:**
- Modify: `worker/test/api.test.mjs`
- Modify: `worker/src/app.mjs`

- [ ] **Step 1: Write the failing tests**

Add a fixture test with paginated RS responses for OpenAI OAuth, API-key, xAI, saved, and unsaved accounts. Request `GET /api/admin/twofa/accounts` with the existing admin headers and assert the response contains only `id`, `email`, `status`, `errorReason`, `saved`, `needsReauth`, and `updatedAt`; `needsReauth` is true only for saved `credential_invalid` or `credential_expired` accounts; password, TOTP, `errorMessage`, and provider fields are absent.

- [ ] **Step 2: Run the focused test and verify it fails**

Run `npm test -- --test-name-pattern="saved account summaries"` from `worker`. Expect a 404 because the list route does not exist.

- [ ] **Step 3: Implement the minimal endpoint**

Add a paginated `listAccounts` helper in `worker/src/app.mjs` that requests `/api/admin/accounts?page=N&pageSize=100`, stops at `data.page.totalPages`, keeps only `provider === 'openai'` and `authenticationKind === 'oauth'`, and calls `vault.get(account.id)` to calculate `saved` and `needsReauth`. Return `ok({ items, page: { totalPages: 1 } })` with `errorReason` restricted to `credential_invalid` and `credential_expired`; never copy `errorMessage` or credentials. Register `GET /api/admin/twofa/accounts` after the health route and require the vault.

- [ ] **Step 4: Run Worker tests**

Run `npm test` from `worker`; expect all tests to pass.

- [ ] **Step 5: Commit**

Run `git add worker/src/app.mjs worker/test/api.test.mjs && git commit -m "feat: expose saved account status summaries"`.

### Task 2: Rust management bridge

**Files:**
- Modify: `backend/src/management/registration.rs`
- Modify: `backend/src/management/router.rs`
- Modify: `backend/src/worker_client.rs`

- [ ] **Step 1: Write failing route/path tests**

Extend the Rust unit tests to assert `worker_path("GET", "api/accounts") == Some("/api/admin/twofa/accounts")` and `operation_request` still rejects unknown paths while the direct route is accepted by the management registration.

- [ ] **Step 2: Run the focused Rust tests and verify failure**

Run `cargo test --manifest-path backend/Cargo.toml worker_client::tests::maps_only_supported_worker_paths`; expect the new mapping assertion to fail.

- [ ] **Step 3: Implement the bridge**

Register `get("api/accounts")` in `registration.rs`, route `("GET", "api/accounts")` in `router.rs` through a helper that forwards a synthetic `ManagementRequest` to the Worker and returns `forward_response`, and permit the exact list path in `worker_client.rs` before the account-id mappings. Keep the existing operation enum unchanged for reauthorization.

- [ ] **Step 4: Run Rust formatting and tests**

Run `cargo fmt --manifest-path backend/Cargo.toml -- --check` and `cargo test --manifest-path backend/Cargo.toml`; expect success.

- [ ] **Step 5: Commit**

Run `git add backend/src/management/registration.rs backend/src/management/router.rs backend/src/worker_client.rs && git commit -m "feat: bridge account status endpoint"`.

### Task 3: Frontend API and saved-account controls

**Files:**
- Modify: `frontend/src/api/request.ts`
- Modify: `frontend/src/api/modules/twofa.ts`
- Modify: `frontend/src/App.vue`

- [ ] **Step 1: Add the API contract test or type-level red check**

Add the `SavedTwoFaAccount` type with `id`, `email`, `status`, optional `errorReason`/`updatedAt`, `saved`, and `needsReauth`, plus `getSavedAccounts()` calling `getJson('api/accounts')`. Run `pnpm typecheck` and confirm it fails until the path union includes `api/accounts`.

- [ ] **Step 2: Implement the API and view state**

Allow `getJson` to accept `api/accounts`; import `getSavedAccounts` and `reauthorizeTwoFaAccount`. In `App.vue`, add `savedAccounts`, `accountsLoading`, `accountActionId`, and an account polling timer. `refreshAccounts()` replaces the list only after a successful response and leaves the old list intact on failure. Schedule a 60-second refresh on mount and clear it on unmount.

- [ ] **Step 3: Implement one-click reauthorization**

Add `reauthorize(account)` that refuses concurrent actions or `!account.needsReauth`, calls `reauthorizeTwoFaAccount(account.id, { submissionId: crypto.randomUUID() })`, assigns the returned task to the existing task panel, shows the existing task polling UI, and refreshes account summaries after task creation. Disable the row button while the action is running and display only stable Chinese status/reason labels.

- [ ] **Step 4: Add the saved-account section**

Render a table/list with email, status, saved indicator, last update, and a `一键重新授权` button only when `needsReauth` is true. Do not render raw RS error text, provider documentation, passwords, or TOTP values. Add a manual refresh button and an empty/loading state.

- [ ] **Step 5: Run frontend checks**

Run `pnpm typecheck`, `pnpm lint`, and `pnpm build` from `frontend`; expect success.

- [ ] **Step 6: Commit**

Run `git add frontend/src/api/request.ts frontend/src/api/modules/twofa.ts frontend/src/App.vue && git commit -m "feat: add saved account reauthorization controls"`.

### Task 4: Regression verification and release

**Files:**
- Modify: `README.md`, `docs/install.md`, or release metadata only if the repository's release checks require the new endpoint/version.

- [ ] **Step 1: Run the complete test suite**

Run Worker tests, Rust format/clippy/tests, and frontend typecheck/lint/build in sequence. Fix only failures caused by this feature.

- [ ] **Step 2: Build release artifacts**

Run the repository packaging script and verify the generated plugin and Worker digests. Do not include vault files, cookies, passwords, TOTP secrets, or production logs.

- [ ] **Step 3: Validate production with fixture data**

Deploy the new artifacts to the configured RS plugin and Worker, request the account summary endpoint with a fixture account, verify a synthetic expired credential gets one reauthorization task, and verify no credential fields appear in the response or logs. Confirm health and task cancellation afterward.

- [ ] **Step 4: Commit release metadata**

Commit only source, manifests, documentation, and generated release artifacts that are tracked by the repository.
