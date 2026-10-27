# Demo-04 — Secure Single-Instance Portfolio Deployment

## Goal

為 Financial Calculation Platform 建立可公開展示的 HTTPS Portfolio Demo 部署方案。

目標環境：

* Single VPS
* Docker Compose
* Caddy
* React Frontend
* Fastify Backend
* PostgreSQL 18
* Single Backend Instance
* Session-owned FakeExecutor

必須保留既有 Backend Orchestration Architecture。

本 Task 分成：

1. Deployment Security Hardening
2. Container Infrastructure
3. Operations & Verification

Codex 負責程式碼、部署配置與測試。

實際 VPS、Domain、DNS、Credentials 與公開上線由 System Owner 操作。

---

## 1. Baseline

Repository:

`good74152/cost-engine-orchestration-platform`

開始前：

1. Fetch 最新 Main。
2. 確認 Demo-03 PR #31 已 Merge。
3. 確認 Demo-02A～02E 都已 Merge。
4. 建立 Feature Branch：

`feature/demo-04-secure-deployment`

不得從舊 Feature Branch 開始。

---

## 2. Required Reading

閱讀：

* AGENTS.md
* README.md
* docs/ARCHITECTURE.md
* docs/REFERENCE.md
* docs/ROADMAP.md
* docs/tasks/demo-03-frontend-ui.md

重點檢查：

* src/app.ts
* src/server.ts
* src/app-mode.ts
* src/executors/executor-factory.ts
* src/modules/demo-session/
* src/modules/demo-scenario/
* frontend/
* docker-compose.yml
* migrations/
* Demo Seed Script

先建立 Deployment Threat Model。

確認：

* 哪些 HTTP Routes 可以公開？
* 哪些必須完全隔離？
* Session Cookie 如何確保安全？
* FakeExecutor 如何維持單 Instance？
* 如何避免公開 API 被大量濫用？
* 如何安全執行 Migration 與 Seed？

不得直接修改 NODE_ENV 限制繞過安全檢查。

---

# Part A — Deployment Architecture

## 3. Docker Infrastructure

建立獨立的 Production-like Deployment Configuration。

建議：

```text
deploy/
├── Caddyfile
├── compose.yaml
├── env.example
├── scripts/
└── README.md

Dockerfile
.dockerignore
```

可以依實際結構調整。

### Containers

三個主要服務：

**1. Web**

* Caddy
* HTTPS
* React Static Files
* Reverse Proxy

**2. Backend**

* Node.js 24
* Fastify
* Demo Runtime
* FakeExecutor
* Single Instance

**3. Database**

* PostgreSQL 18
* Persistent Docker Volume
* Internal Network Only

### Requirements

* PostgreSQL 不公開 5432。
* Fastify 不直接公開 3000。
* 只有 Caddy 對外提供 80/443。
* Frontend 和 Backend 必須同源。
* 不使用 CORS Wildcard。
* 不使用 Vite Development Server。
* 不允許多個 Backend Replicas。
* 不使用 Kubernetes。

### PostgreSQL 18

確認官方 Image 的 PGDATA / Volume Layout。

不得沿用不相容的舊版資料目錄掛載方式。

---

# Part B — Production Demo Runtime

## 4. Explicit Public Demo Mode

目前 FakeExecutor 只允許 development/test。

新增明確受限的 Public Demo 啟用策略。

要求：

1. 預設 production 環境仍禁止 FakeExecutor。
2. Core Runtime 在 production 仍不能使用 FakeExecutor。
3. 只有明確啟用 Public Demo Profile 時才能使用。
4. APP_MODE 必須是 demo。
5. NODE_ENV 必須是 production。
6. EXECUTOR_TYPE 必須是 fake。
7. Public Demo 必須使用 HTTPS Origin。
8. 不允許未設定的 Production Demo 啟動。

可以新增：

`DEMO_PUBLIC_ENABLED=true`

但不能只因為設定這個變數，就繞過其他安全條件。

必須建立集中式 Environment Validation。

### Important

不能直接把既有 `isApprovedFakeExecutorEnvironment()` 改成允許所有 production。

必須保留 Core/Demo 的安全邊界。

原本的 Local Development 和 Integration Tests 仍需正常運作。

---

## 5. API Exposure

公開部署只允許：

* Frontend 靜態資源
* Demo Session APIs
* Demo Scenario APIs
* Demo Read APIs
* Demo Manual APIs
* 必要的 Health Check

不得公開：

* Raw Ingestion Mutation APIs
* Internal Executor Controls
* Core-only APIs
* Debug Endpoints
* Database Administration
* Migration / Seed HTTP Endpoints

除了既有明確保護的 Demo API，不得額外開放新的 Backend Mutation API。

使用 Integration Tests 驗證未授權路由不可存取。

---

# Part C — Security

## 6. HTTPS & Cookie

Production Public Demo 必須使用：

* HTTPS
* Secure Cookie
* HttpOnly
* SameSite=Strict
* __Host- Cookie Prefix
* Exact Origin Validation
* Existing CSRF Header
* Cache-Control: no-store for session/API responses

Browser API Requests：

`credentials: include`

不能將 Session Token 放在：

* localStorage
* URL
* Query String
* Application Logs

### Reverse Proxy

必須正確處理 HTTPS Termination。

Caddy → Fastify 使用內部 Docker Network。

Origin Validation 應使用明確設定的 Public HTTPS Origin。

不得盲目信任任意 Client 傳入的 Forwarded Headers。

Production Configuration 不得接受任意 Origin。

---

## 7. Public Abuse Protection

公開 Demo 不可以無限制建立 Session 或 Executor。

建立基本保護：

* Session Creation Rate Limit
* API Mutation Rate Limit
* Request Body Size Limit
* Maximum Active Sessions
* Existing Executor Capacity Limit
* Existing Per-session Queue Limit
* 適當的 HTTP 429/503 Response

限流必須考慮可信任 Reverse Proxy 與 Client IP。

不得依賴可由外部任意偽造的 IP Header。

在單 Instance 假設下，可使用簡單、可理解的方案。

不要為了 Rate Limiting 引入 Redis。

全域 Session 容量控制必須考慮 Concurrent Requests，不能只做不安全的查詢後判斷。

### Required Tests

驗證：

* 高頻 Session Create。
* Concurrent Session Create。
* Capacity Reached。
* Rate Limit。
* Session Ownership 不受影響。
* 不會建立超出設定容量的 FakeExecutor。
* 錯誤回應不洩漏內部資訊。

---

# Part D — Session Lifecycle

## 8. Cleanup

目前 Session Expiration / Reset 已經存在。

部署後必須增加有界的 Periodic Maintenance。

目的：

* 清除 Expired Sessions。
* 清除 Revoked Session Data。
* 釋放對應 FakeExecutor。
* 避免長時間運作造成無限制記憶體或資料增長。

要求：

* Single Instance。
* 每次 Cleanup 有數量上限。
* 不重疊執行 Cleanup。
* Cleanup Failure 不得破壞其他 Session。
* 保留既有 Transaction / Unknown Commit Recovery。
* 記錄 Cleanup Success / Failure。
* 不得在不安全的時間清除 Active Session。

不引入 Background Queue。

可以使用受控的 In-process Scheduled Maintenance。

Application Shutdown 時必須停止排程。

---

# Part E — Deployment Lifecycle

## 9. Startup

Production Startup 必須依照正確順序：

```text
Validate Environment
        ↓
Check Database
        ↓
Verify Migration State
        ↓
Verify Demo Seed
        ↓
Initialize Runtime
        ↓
Invalidate Previous Sessions
        ↓
Start HTTP Server
        ↓
Ready
```

Migration / Seed 是明確的部署操作。

不得讓每個 HTTP Instance 在啟動時自行執行 Schema Migration。

不得自動清空 Database。

### Seed

沿用既有 Demo Configuration Seed。

必須支援受控的 Production Demo 初始化，同時保留：

* Explicit Database Target
* Idempotent Seed
* Existing Configuration Validation
* No DATABASE_URL Fallback
* No Destructive Configuration Replacement

不得將 Production Database Credentials 寫進 Repository。

---

## 10. Deploy & Restart

目前系統不支援多個 Demo Backend Instances 同時運作。

因此第一版 Deployment 採用：

**Stop → Deploy → Start**

允許短暫 Maintenance Downtime。

不能使用會讓兩個 Backend 同時對同一 PostgreSQL 提供 Demo Session 操作的 Rolling Deployment。

### Requirements

* Deploy 前確認只有一個 Backend。
* 停止接受新請求。
* 等待或安全中止進行中的操作。
* 不得在 Executor Dispatch 尚未安全處理時直接宣稱操作完成。
* 保留 PostgreSQL Durable State。
* 新 Process 啟動時沿用既有 Session Invalidation 規則。
* Browser 收到 401 時顯示 Session Expired。
* 不得在 Deployment 過程產生兩個可接受請求的 Demo Runtime。

必要時提供 Maintenance Page。

### Rollback

提供操作文件：

* 如何回復上一版 Application Image。
* 如何處理 Migration Compatibility。
* 何時必須先備份。
* 如何拒絕不安全的 Migration Down。

不得在 Rollback 時自動刪除 Dataset / Session History。

---

# Part F — Persistence & Backup

## 11. PostgreSQL

使用 Persistent Volume。

Production Compose 不得使用：

* 預設 admin/admin Credentials
* 公開 PostgreSQL Port
* 無持久化儲存
* 直接刪除 Volume 的 Deploy Command

建立基本 Backup / Restore 操作手冊。

至少說明：

* PostgreSQL Backup Command
* Backup Storage Location
* Off-host Backup Requirement
* Restore Validation
* Migration 前備份
* Disk Usage Monitoring

Demo 資料可以被重建，不代表可以忽略資料保護。

不得把 Database Backup 加入 Git。

---

# Part G — Observability

## 12. Logs & Health

新增適當的：

* Readiness Check
* Database Health Check
* Startup Failure Logs
* Session Creation Rate Limit Logs
* Executor Capacity Logs
* Reset / Cleanup Failure Logs
* Deployment Version Identification

不得記錄：

* Raw Cookie
* Session Token
* Token Hash
* Database Password
* Raw SQL Credentials

### Health Semantics

Application 尚未完成 Session Invalidation、Database Validation 或必要初始化前，不可宣稱 Ready。

不要把單純 Node Process 存活誤當成 Backend Ready。

---

# Part H — Frontend

## 13. Production Frontend

使用既有：

`frontend/`

建置 Vite Production Assets。

由 Caddy 提供靜態檔案。

要求：

* Same-origin API。
* SPA Route Refresh 正常。
* Browser History Routing 正常。
* Assets Cache Policy 正確。
* HTML 不應長期快取。
* 正確的 Content Security Policy。
* 不使用 Development Proxy。
* 不在 Bundle 中放入 Secrets。

Frontend 既有功能必須全部維持：

* Happy Path
* Failure & Retry
* Lost Response Recovery
* Free Exploration
* Reset
* Resource Explorer

---

# Part I — Tests

## 14. Required Verification

建立 Deployment-focused Tests。

至少涵蓋：

1. Production Demo Environment Validation。
2. Core Production FakeExecutor 仍被拒絕。
3. Explicit Public Demo 可以安全啟動。
4. Secure Cookie。
5. Origin / CSRF。
6. Rate Limiting。
7. Session Capacity。
8. Periodic Cleanup。
9. Backend Restart Session Invalidation。
10. Production Route Exposure。
11. Health / Readiness。
12. Docker Compose Configuration。
13. Frontend Static Serving。
14. SPA Refresh。
15. Missing Secret / Invalid Environment Fail Closed。
16. Persistent Database Restart。
17. Backup / Restore Procedure Validation。
18. No Concurrent Backend Instances。
19. Guided Scenarios Regression。
20. Existing Core Regression。

### E2E

使用隔離的 Disposable Environment。

測試：

```text
HTTPS Entry
    ↓
Start Session
    ↓
Create Scenario
    ↓
Run All Steps
    ↓
Publish
    ↓
Reset
```

不得對真正持久化的公開 Demo Database 執行破壞性 Integration Tests。

如果沒有 VPS / DNS / TLS Credentials，應完成可在本機驗證的部署配置，並明確列出未驗證項目。

不得宣稱尚未執行的 Public HTTPS Test 已通過。

---

# Part J — CI/CD

## 15. CI

建立基本 GitHub Actions。

至少執行：

* Backend Build
* Frontend Typecheck
* Frontend Tests
* Frontend Build
* Deployment Configuration Validation

需要 PostgreSQL 的測試使用隔離的 CI Service Container 或 Disposable Database。

不得接觸公開部署資料庫。

### Deployment

第一版以 Manual Deployment 為主。

不要在 Merge 時自動部署公開網站。

提供可重複執行的部署腳本與 Runbook。

未經 System Owner 明確授權，不得執行：

* DNS 修改
* VPS Provisioning
* Production Migration
* Production Seed
* Public Deployment
* Destructive Cleanup

---

# Part K — Documentation

## 16. Required Documentation

新增：

`docs/tasks/demo-04-secure-deployment.md`

`docs/DEPLOYMENT.md`

文件必須包含：

* Architecture
* Production Demo Security Boundaries
* Environment Variables
* Docker Build
* HTTPS / DNS
* Database Initialization
* Migration / Seed
* Startup
* Deployment
* Backup / Restore
* Rollback
* Monitoring
* Known Limitations
* Manual Operator Steps
* Test Evidence

如有重大 Runtime Security 決策，新增 ADR。

更新：

* README.md
* docs/ARCHITECTURE.md
* docs/REFERENCE.md
* docs/ROADMAP.md

---

# Part L — Constraints

## 17. Must Preserve

不得破壞：

* Dataset Canonical Identity
* Dataset Versioning
* Job / Attempt State Machines
* Immutable Snapshot
* Dispatch Idempotency
* Unknown Outcome Recovery
* Session Ownership
* Scenario Step Ledger
* Session Reset Atomicity
* Existing Core Tests

不得引入：

* Kubernetes
* Redis
* RabbitMQ
* Kafka
* Distributed Locking
* Real Airflow Adapter
* Multi-instance Demo Runtime

不要為了部署而重寫 Core Architecture。

---

# Part M — Acceptance Criteria

## 18. Definition of Done

Codex 交付必須滿足：

* Production Docker Build 成功。
* Single-instance Compose Configuration 正確。
* HTTPS 配置完成。
* Production Demo Runtime 有明確安全限制。
* Session / API 有基本濫用保護。
* Periodic Cleanup 正常。
* Frontend Production Assets 正常。
* Migration / Seed 可安全執行。
* Backup / Restore 文件完整。
* CI 可以執行。
* Existing Regression Tests 通過。
* 本機容器整合測試通過。
* 有完整的 VPS 部署 Runbook。

### Required Commands

執行：

```bash
npm run build
npm run ui:typecheck
npm run ui:test
npm run ui:build
npm run test:demo-02e
npm run test:demo-02d
npm run test:demo-02c
npm run test:milestone
git diff --check
```

另執行新增的 Deployment Tests、Docker Build 與 Compose Configuration Validation。

回報實際執行結果。

---

# Part N — Delivery

完成後：

1. Commit。
2. Push Feature Branch。
3. Create Pull Request。
4. 不要 Merge。
5. 不要自行公開部署。

PR 必須包含：

* Architecture Summary
* Security Changes
* Docker Infrastructure
* Environment Configuration
* CI
* Tests
* Deployment Runbook
* Manual Operator Checklist
* Known Limitations

**System Owner Review Required。**

沒有實際完成的 VPS / HTTPS / Production E2E 驗證，不得宣稱 Deployment 已正式完成。

本 Task 完成的是安全部署能力與可驗證的部署配置。

實際公開上線仍需要 System Owner 授權與操作。

## Implementation and review navigation

Branch: feature/demo-04-secure-deployment, from fetched main
c1c2a883cc9f63fea701286ba95b0c639c5e4603 (merged Demo-03 PR #31).
Demo-02A–02E are included in that branch point. Implementation is subject to
System Owner review, not automatically accepted or deployed.

- [Threat model and bounded runtime decisions](../adr/0013-restricted-public-demo-deployment.md)
- [Deployment, operator checklist, backup/restore and rollback](../DEPLOYMENT.md)
- [Executed local verification and unverified public operations](../verification/demo-04-deployment.md)

Session history remains under ADR-0010. Periodic maintenance removes only inactive
owner data and releases confirmed inactive fakes; a retained-session admission
ceiling bounds audit-row growth without deleting history. Single VPS/backend and
no concurrent Core/external/config writer remain mandatory. No historical
migration or financial state machine is changed.

## Final review fix — rate accounting and internal health

Check session-creation/per-IP limits before the global limit. A rejected local
request must not spend another user's global quota. Check and charge synchronously
with one fixed-window timestamp; concurrent requests must still obey every cap.
The existing Docker loopback readiness probe is sufficient. Close public health
paths at Caddy and in the public backend profile before DB access; preserve Core
health behavior, Session identity and Scenario semantics. No new service or limiter.
