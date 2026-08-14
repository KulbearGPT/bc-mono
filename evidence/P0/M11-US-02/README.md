# M11-US-02 候选池数据与原子选择 API 证据

状态：完成。本 Story 只声明数据库与统一 API 完成；Discord 面板、自然截止 Worker、选秀语音、客服通知和真实 Guild UAT 属于 M11-US-03/04。

## 验收覆盖

- `AT-SEL-001`：候选池固化 1–30 整分钟窗口，客户可提前结束；空池继续等待显式创建下一轮，订单、版本和资金事实不变。
- `AT-SEL-002`：ACTIVE 且技能匹配的陪玩可在 `OFFLINE`/`BUSY` 下跨订单报名；报名/撤回不创建参与人、不占活动槽。
- `AT-SEL-004`：终选事务锁订单、池、需求和按陪玩排序的 advisory active-slot 锁；重验资格与容量，写入逐人项目/价格/分成快照，跨池报名失效。两个订单并发选择同一陪玩时仅一个事务成功。
- `AT-SEL-005`：部分选择保留正式参与人，未填满订单保持 `PENDING_DISPATCH`；空轮不自动续开，客户显式继续才创建新轮。
- 关联覆盖：`AT-DSP-013`、`AT-DSP-014`、`AT-DSP-016`、`AT-MULTI-007`、`AT-COMP-002` 的 API/DB 部分。

## 修改文件

- `apps/api/src/selection-pools.ts`、`server.ts`、`index.ts`、`security.ts`、`package.json`
- `database/prisma/schema.prisma`
- `database/prisma/migrations/000029_selection_pool_dispatch/migration.sql`
- `database/src/immutable-records.ts`
- `tests/m11-us-02-selection-pools-api.spec.ts`
- `tests/m11-us-02-selection-pools-postgres.spec.ts`
- 双份 backlog、双份 `Codex-P0开发TODO.md`

## RED / GREEN

- RED：`npx vitest run tests/m11-us-02-selection-pools-api.spec.ts` → 0 tests，缺少 `@blackcat/api/selection-pools` 导出。
- GREEN：`npx vitest run tests/m11-us-02-selection-pools-api.spec.ts tests/m11-us-02-selection-pools-postgres.spec.ts` → 2 files / 8 tests passed。
- 关联回归：`npx vitest run tests/m11-us-02-selection-pools-api.spec.ts tests/m11-us-02-selection-pools-postgres.spec.ts tests/m10-us-02-db.spec.ts tests/m10-us-03-postgres.spec.ts` → 4 files / 17 tests passed。
- `npx tsc -p apps/api/tsconfig.json --noEmit` → passed。
- `npx prisma validate --schema database/prisma/schema.prisma` → schema valid。
- 全量空库迁移链（`000001`–`000029`，`ON_ERROR_STOP=1`）→ passed。

## 边界与剩余风险

- 旧 `availability`/presence 数据列暂留用于历史兼容，但候选池资格 SQL 不读取它们；玩家端设置入口与旧抢单 Bot 的删除在 M11-US-03 完成。
- 自然截止的可恢复 Worker、Outbox、语音权限和客服通知尚未实现，不在本 Story 完成声明内。
- 外部 PostgreSQL/Discord/Dashboard 验收归 M11-US-04；当前证据为本地真实 PostgreSQL 临时实例。
