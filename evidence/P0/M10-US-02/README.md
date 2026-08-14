# M10-US-02 多陪玩数据与只追加事实证据

## Story 与验收

- Story：`M10-US-02`
- 验收：`AT-MULTI-001`、`AT-MULTI-004`
- 范围：数据库模型、迁移、历史数据回填及只追加约束；不声称参与者管理 API、资金重平衡、Dashboard 或 Discord 交互已完成。

## TDD 记录

- RED：`npx vitest run tests/m10-us-02-db.spec.ts`，新增迁移尚不存在时 `1 file / 2 tests failed`。
- GREEN：`npx vitest run tests/m10-us-02-db.spec.ts`，`1 file / 3 tests passed`。
- 聚焦回归：`npx vitest run tests/m10-us-01-contract.spec.ts tests/m10-us-02-db.spec.ts tests/m0-us-02.spec.ts`，`3 files / 11 tests passed`。

## 实现结果

- 新增 `order_participants`，每条明细独立绑定服务目录版本，并固化游戏、服务、地区、计费、数量、客户价格、行价格、分成来源与预计收益快照。
- 同一订单中的同一陪玩只允许一条有效明细；移除使用状态事实表达，不物理删除。
- 新增只追加 `order_participant_events`，数据库触发器拒绝更新或删除历史事件。
- 最终资金捕获后，数据库拒绝参与明细的项目、价格和移除等业务变更。
- `player_earnings` 可关联具体参与明细；旧收益允许暂时保持空关联，避免伪造无法证明的历史事实。
- 对能够可靠匹配订单陪玩与服务目录版本的旧订单回填参与明细、`ADDED` 事件和收益关联；历史分成来源明确标记为 `LEGACY_ORDER_SNAPSHOT`。

## 验证证据

- `npm run typecheck`：通过。
- `npm run db:verify:migration`：完整迁移链通过，`table_count=76`，抽样只追加与状态约束全部通过。
- `npx prisma validate --schema database/prisma/schema.prisma`：schema valid。
- `git diff --check`：通过。

## 修改文件

- `database/prisma/migrations/000019_multi_player_order_participants/migration.sql`
- `database/prisma/schema.prisma`
- `database/src/immutable-records.ts`
- `docs/P0开发交付包/02-API/openapi.yaml`
- `outputs/P0开发交付包/02-API/openapi.yaml`
- `docs/P0开发交付包/03-数据模型/schema.prisma`
- `outputs/P0开发交付包/03-数据模型/schema.prisma`
- `tests/m10-us-02-db.spec.ts`
- 双份 `Codex-P0开发TODO.md` 与本证据文件

## 剩余边界

- 参与者管理 API、预留差额重平衡、全员 readiness、逐人捕获收益、Dashboard/Discord 操作和真实 Guild UAT 由后续 M10 Story 实现。
- 旧数据只有在订单同时具备陪玩和可验证服务目录版本时才回填；无法可靠推断的历史记录保持原状，不猜测项目或分成来源。
