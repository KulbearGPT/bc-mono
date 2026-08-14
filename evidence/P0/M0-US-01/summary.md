# M0-US-01 Evidence

Story：可复现的本地工程与运行骨架

验收关联：`AT-CHN-001`、`AT-CHN-002` 的工程前置能力；OpenAPI operationId `getHealth`、`getReadiness`。

## 修改文件

- `.gitignore`
- `.env.example`
- `package.json`
- `package-lock.json`
- `tsconfig.base.json`
- `tsconfig.build.json`
- `vitest.config.ts`
- `docker-compose.yml`
- `README.md`
- `modules/platform/**`
- `apps/api/**`
- `apps/bot/**`
- `apps/dashboard/**`
- `tests/m0-us-01.spec.ts`

## RED 证据

命令：

```bash
npm run m0:verify
```

结果：

```text
FAIL tests/m0-us-01.spec.ts
Error: Cannot find module '@blackcat/api/server'
```

新增 dev 脚本可复现性测试后的 RED：

```text
expected 'concurrently -n api,bot,dashboard ...' to contain 'dotenv -e .env.example'
```

## GREEN 证据

命令：

```bash
npm run m0:verify
```

结果：

```text
RUN  v4.1.10
Test Files  2 passed (2)
Tests  14 passed (14)
```

命令：

```bash
npm run typecheck
```

结果：

```text
tsc -b tsconfig.build.json
exit 0
```

## HTTP Smoke

命令：

```bash
DATABASE_URL=postgresql://blackcat:blackcat@localhost:5432/blackcat \
API_BASE_URL=http://localhost:3100 \
API_PORT=3100 \
BOT_SERVICE_TOKEN=dev-service-token \
npm run start -w @blackcat/api
```

`GET /health`：

```text
HTTP/1.1 200 OK
{"data":{"status":"OK"}}
```

`GET /ready`：

```text
HTTP/1.1 503 Service Unavailable
{"data":{"status":"NOT_READY","dependencies":[{"name":"database","status":"UNREACHABLE","required":true}]}}
```

说明：`/ready` 现在会使用 `DATABASE_URL` 登录 PostgreSQL，并检查 baseline schema 中的 `public.users` 是否存在；仅端口可达不再代表数据库可用。Discord Bot credential 暂未提供，按用户要求不阻断本地验证。

## 本地数据库启动口径

- 应用进程使用 `DATABASE_URL=postgresql://blackcat_app:blackcat_app@...`
- 迁移使用 `MIGRATION_DATABASE_URL=postgresql://blackcat:blackcat@...`
- fresh PostgreSQL 启动后先执行 `npm run db:migrate:deploy`，再启动 API/Bot/Dashboard。

## Bot Piece 验证

命令：

```bash
DATABASE_URL=postgresql://blackcat:blackcat@localhost:5432/blackcat \
API_BASE_URL=http://localhost:3000 \
BOT_SERVICE_TOKEN=dev-service-token \
npm run pieces -w @blackcat/bot
```

结果：

```text
pieces:
- commands/service-center.ts
- listeners/ready.ts
```

## Compose 验证

命令：

```bash
docker compose config
```

结果：

```text
exit 0
services: postgres, api, bot, dashboard
```

## Dependency Audit

命令：

```bash
npm audit --audit-level=moderate
```

结果：

```text
found 0 vulnerabilities
```

## 未关闭项

- 真实 Discord 登录和测试 Server E2E 等待 Bot credential。
- Follow-up code review 已通过；真实 Discord credential 缺失按用户要求不阻断 M0-US-01 完成。

## 2026-08-04 本地运行骨架修复

- RED：`npx vitest run tests/m0-us-01.spec.ts` 以根命令必须包含 `npm run worker -w @blackcat/api` 为断言失败，确认原 `npm run dev` 只启动 API、Bot、Dashboard，订单 Outbox 无消费者。
- GREEN：根命令现同时启动 API、Worker、Bot、Dashboard；`tests/m0-us-01.spec.ts` 与 Railway runtime 回归共 `2 files / 23 tests passed`。
- Sandbox 事实：订单 `P-DBDE4FB0` 提交、600 CAT 预留及 `DISPATCH_START` 入队成功，但 Worker 启动前任务保持 `PENDING / attempt_count=0`；单独启动 Worker 后生成两轮派单尝试，首席位已接单、第二席位通知成功。
