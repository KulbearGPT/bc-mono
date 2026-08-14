# M22-US-02 独立礼物事实、迁移与统一 API 证据

日期：2026-08-13

分支：`codex/order-review`

Story：`M22-US-02`

验收：`AT-GIFT2-001`、`AT-GIFT2-002`、`AT-GIFT2-003`

## 完成范围

- 新增 `000043_standalone_anonymous_gifts` 迁移：礼物事实记录可信 Guild、`ORDER/STANDALONE` 来源与 `PUBLIC/ANONYMOUS` 展示模式；独立礼物允许 `order_id = NULL`，身份和匿名选择不可修改。
- 新增统一业务 API：`GET /api/v1/gift-center`、`POST /api/v1/gift-center/affordability`、`POST /api/v1/gift-center/gift-requests`。
- 独立请求只接受 `playerProfileId`，不接受 `receiverId`。API 在最终事务内重新验证同 Guild Discord 绑定、陪玩审核状态、用户状态、礼物目录版本/价格和内部 CAT 可用余额，再派生真实接收用户。
- affordability 只读且余额不足零写入；创建时以付款人和币种为并发锁边界，真实 PostgreSQL 用例证明余额只够一份时两个并发请求最多成功一个。
- 独立礼物复用原有预留、客服核对、审批、捕获、消费、返佣与 Outbox 状态机；订单内批量送礼接口保持兼容。
- 匿名是礼物请求的不可变事实。客服任务、资金和审计保留真实 `senderId`；公共播报 payload 只使用“匿名老板”。
- 后台礼物目录、审批、运营指标和佣金 Guild 归属支持独立礼物，并继续按可信 Actor Guild 隔离。

## 实际修改文件

- `database/prisma/migrations/000043_standalone_anonymous_gifts/migration.sql`
- `apps/api/src/gifts.ts`
- `apps/api/src/admin-directory.ts`
- `apps/api/src/approvals.ts`
- `apps/api/src/commissions.ts`
- `apps/api/src/dashboard-metrics.ts`
- `outputs/P0开发交付包/02-API/openapi.yaml` 及 `docs/` 镜像
- `outputs/P0开发交付包/03-数据模型/状态枚举与约束.md` 及 `docs/` 镜像
- `scripts/verify-m0-us-02-migration.sh`
- `tests/m22-us-02-standalone-gift-api.spec.ts`
- `tests/m22-us-02-standalone-gift-postgres.spec.ts`
- `tests/m4-us-03-api.spec.ts`
- `tests/m4-us-03-db.spec.ts`
- `tests/m7-us-07-retirement.spec.ts`
- `outputs/P0开发交付包/06-开发计划/backlog.csv`
- `outputs/Codex-P0开发TODO.md`
- `evidence/P0/acceptance-matrix.csv`

## TDD 证据

### RED

命令：

```text
npx vitest run tests/m22-us-02-standalone-gift-api.spec.ts
```

初始结果：`1 file / 5 tests failed`；三条独立送礼路由均不存在，匿名播报仍暴露真实发送者名称。

### GREEN：API、PostgreSQL 并发、订单兼容与匿名投影

命令：

```text
npx vitest run tests/m22-us-02-standalone-gift-postgres.spec.ts tests/m22-us-02-standalone-gift-api.spec.ts tests/m4-us-03-api.spec.ts tests/m4-us-03-db.spec.ts tests/m6-us-06-api.spec.ts tests/m3-us-03-worker.spec.ts
```

结果：`6 files / 36 tests passed`。

覆盖同 Guild ACTIVE 接收人、伪造 `receiverId`、余额不足零写入、目录失效、真实数据库并发超支、匿名公共播报、内部真实 sender、订单礼物批量兼容和后台投影。

## 静态、合同与迁移门禁

```text
npm run typecheck
npm run lint:api
npm run db:validate
npm run db:verify:migration
npm run quality:routes
git diff --check
```

结果：TypeScript、API ESLint、Prisma、完整迁移不变量和空白检查通过；`186` 个生产 operation 与 OpenAPI 双向精确一致。

## 全量回归

```text
npm test
```

结果：`290 files / 1449 tests passed`。

## 剩余边界

- `M22-US-03` 的 Discord 专用频道常驻卡、低点击组件和重启恢复尚未实现。
- `M22-US-04` 的客服辅助指令仍等待产品明确“客服直接预留老板余额”或“生成老板最终确认”；本 Story 没有授予代客扣款能力。
- `M22-US-05` 的真实 Guild、手机端和多角色隐私 UAT 尚未执行。
