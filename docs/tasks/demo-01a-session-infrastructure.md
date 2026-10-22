# Demo 01A — Session Infrastructure

## 1. 目標

建立 Demo Session 基礎架構，讓未來的 Guided Scenarios 和 Free Exploration 能安全識別使用者及檢查資料歸屬。

本階段**不實作受保護的 Domain API**，因此不宣稱已完成端到端資料隔離。

## 2. Session 資料模型

新增 `demo_sessions` migration。

| 欄位 | 說明 |
|---|---|
| id | Session UUID |
| company_code | 唯一的 Demo 公司代碼，最長 20 字元 |
| token_hash | 32-byte SHA-256 Hash |
| created_at | 建立時間 |
| expires_at | 到期時間 |
| revoked_at | 撤銷時間 |

Session Token 使用 32 bytes 安全隨機值，資料庫不儲存明文。
每個 Session 自動產生不同的 companyCode，不修改現有 Dataset canonical identity。

## 3. API Contract

| API | 功能 |
|---|---|
| POST /demo/sessions | 建立 Session；有效 Cookie 可重用原 Session |
| GET /demo/sessions/current | 使用 Cookie 取得目前 Session |

成功回應包含 sessionId、companyCode、expiresAt、status，不包含 Token。
無效、過期或撤銷的 Session 回傳 **401 DEMO_SESSION_UNAVAILABLE**。

## 4. Cookie 與有效期限

使用 HttpOnly Cookie。正式 HTTPS 環境使用 Secure、SameSite=Strict、Path=/，不允許 JavaScript 讀取 Token。
Session 固定有效 **4 小時**，不自動延長。
Expiration 與 Revocation 阻止後續操作，但不取消已開始的計算。
Token、Token Hash 不得出現在 Log。

## 5. Ownership Validation

建立可重用的 Dataset、Job、Attempt ownership validator。
必須根據已驗證的 Session 和 PostgreSQL 資料關聯判斷，不能相信前端提供的 companyCode。
跨 Session 資源檢查必須失敗，且不能透露其他 Session 的資源資訊。
本階段只建立並測試 Validator，不修改現有 Domain API。

## 6. Operation Coordinator

使用單一 Backend Instance 的 Per-Session Promise Queue。
同 Session 操作依序執行，不同 Session 可以並行。
前一個操作失敗，不得阻塞後續操作；排隊期間 Session 過期，後續操作必須拒絕。
限制 Queue 長度，避免無限累積請求。
Coordinator 不取代 PostgreSQL Transactions 或 Locks。

## 7. PostgreSQL Integration Tests

必須驗證 Session 建立、Cookie 恢復、Token Hash、companyCode 唯一性、Expiration、Revocation、Ownership Validation，以及同 Session 操作序列化。
所有測試使用獨立的 disposable PostgreSQL database。
既有 npm run test:milestone 不得退化。

## 8. 實作限制與交付

從最新 main 建立獨立 feature branch。
不修改 Task 007 已接受的 Dataset、Job、Attempt state machines、Executor Contract 或 historical migrations。
不加入 Redis、Message Queue 或 Distributed Lock。
不實作 Reset、Scenario Runner、Frontend、Idempotency-Key 或 Cloud Deployment。
完成後提交 PR，等待 System Owner Review。**禁止自動 Merge**。

## Implementation details within this scope

- Baseline: latest fetched main `f0559ee1dd44f10bd15e23aa11d53377fd7a4088`;
  branch `feature/demo-01a-session-infrastructure`. Task 007 acceptance is recorded
  in `docs/verification/task-007-final-acceptance.md`.
- POST accepts an empty JSON object and `X-Demo-Session: 1`. No cookie creates
  a new row (201); a valid cookie returns the same session (200), without token
  rotation, expiry extension or Set-Cookie. A supplied invalid cookie returns
  401, rather than silently allocating a replacement. GET returns 200 or 401.
  Safe status is `ACTIVE`; unavailable reasons share one generic message/code.
- New session endpoints only: no protected Domain API, app-mode change or extra
  resource read endpoint. Existing dataset/job/callback/raw/fake routes remain
  unchanged and unauthenticated. These validators are NOT end-to-end isolation.
- Token: canonical 43-character base64url encoding of 32 crypto-random bytes;
  only SHA-256 of decoded bytes is stored. High entropy makes password hashing
  unnecessary. companyCode is independently random `DEMO_` + 15 uppercase hex
  characters, with database uniqueness and at most five collision retries.
  Session allocations are retained after expiry/revocation, never reused.
- Central cookie names: `__Host-ce_demo_session` for Secure transport and
  `ce_demo_session` for explicitly selected development/test HTTP only. No
  Domain attribute; HttpOnly, SameSite=Strict, Path=/; remaining lifetime bounded
  by persisted expiry. Production/unspecified environments default to Secure;
  insecure override outside development/test fails startup.
- Session responses/errors are no-store. POST's custom header and JSON body
  prevent simple cross-origin form requests; no credentialed CORS is enabled.
  If Origin is supplied it must match the configured origin (or direct request
  origin); cross-site Fetch Metadata is rejected. Non-browser callers may omit
  Origin but must supply the header. Configure the explicit origin behind TLS
  proxies. HttpOnly does not protect against same-origin XSS. CSRF rejection is
  403 DEMO_SESSION_CSRF_REJECTED; malformed body is 400 INVALID_REQUEST.
- Trusted session contexts originate only from durable cookie authentication.
  Ownership joins traverse version -> series, job -> version -> series and
  attempt -> job -> version -> series; also provide a series validator. Missing
  and foreign resources return the same generic DEMO_RESOURCE_UNAVAILABLE.
  Recheck durable eligibility before ownership queries and queued operation
  bodies; no caller-supplied companyCode/session ID establishes authentication.
- Expiration uses current PostgreSQL time and expires at equality. Service-only
  revocation is durable/idempotent; no public revoke endpoint or reactivation.
  Already-admitted operations may finish after expiry/revocation; no accepted
  executor work is canceled. Ownership links are immutable in supported code;
  validators do not acquire orchestration locks or change accepted lock order.
- Coordinator defaults: at most 32 queued/running operations per session and
  1024 live session keys; overflow rejects with DEMO_SESSION_QUEUE_FULL. Limits
  are constructor-configurable positive integers for bounded tests. Completed
  tails are removed; failures propagate without poisoning successors. No SQL
  transaction/client is retained while queued or throughout the operation body.
  Single process only; restart loses pending work, not persisted sessions.
- Migration down is permitted only when demo_sessions is empty; otherwise it
  fails explicitly without deleting credentials/ownership history. No old
  migration or historical orchestration data is edited.
- Cookie/Set-Cookie/Authorization logging is redacted. Session DB errors are
  sanitized at the session boundary; token/hash/query bindings never become
  public exceptions or session error logs. No bearer in JSON, URLs or snapshots.

## Verification evidence

Pending implementation and execution. Required: build, focused real PostgreSQL
suite, unchanged milestone gate and diff check. Record exact source revision,
commands, exit codes, counters, environment, warnings and owned DB teardown.
