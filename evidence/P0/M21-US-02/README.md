# M21-US-02 评价事实与统一业务 API 证据

日期：2026-08-13

分支：`codex/order-review`

Story：`M21-US-02`

验收：`AT-REVIEW-001`、`AT-REVIEW-004`

## 完成范围

- 新增 PostgreSQL 迁移与运行时 Prisma 模型：按订单目标保存不可变星级、单条可选追加留言，以及明确同意后冻结的五星公开快照。
- 新增统一业务 API 的四条真实路由：读取私密评价中心、批量保存同星级、追加留言、申请发布五星安全快照。
- 评价目标只由 API 根据可信 Guild、订单所有者、完成时有效陪玩明细和本单实际首位客服响应派生；请求不能提交陪玩、客服或接收者 ID。
- 星级成功即保存；一至五星均不要求理由或留言。批量写入对伪造目标、重复目标、已评价目标和并发冲突保持整批零写入。
- 评价窗口为完成后 24 小时。评价事实、留言和同意快照不可修改或删除；评价流程不改变订单状态、金额、钱包流水或资金预留。
- 迁移会回填带真实客服归属的旧客服评价及留言；旧客服评价入口在 Discord 切换前于同一事务同步写入新模型，避免迁移窗口数据丢失。
- 公开请求只在字面确认 `PUBLISH_FIVE_STAR_SNAPSHOT` 后创建快照与 `REVIEW_BROADCAST` Outbox 事件；快照仅含订单基本信息及当前五星目标，不含低分、留言、客户身份、金额或内部关联字段。实际频道投递属于 `M21-US-04`，本 Story 未声称完成。

## 实际修改文件

- `database/prisma/migrations/000042_order_experience_reviews/migration.sql`
- `database/prisma/schema.prisma`
- `apps/api/src/order-experience-reviews.ts`
- `apps/api/src/index.ts`
- `apps/api/src/server.ts`
- `apps/api/src/security.ts`
- `apps/api/src/support-response-rating.ts`
- `apps/api/package.json`
- `tests/m21-us-02-order-experience-reviews.spec.ts`
- `tests/m21-us-02-postgres.spec.ts`
- `tests/m12-us-04-postgres.spec.ts`
- `outputs/P0开发交付包/06-开发计划/backlog.csv` 及 `docs/` 镜像
- `outputs/Codex-P0开发TODO.md` 及 `docs/` 镜像

## TDD 证据

### RED

命令：

```text
npx vitest run tests/m21-us-02-order-experience-reviews.spec.ts
```

初始结果：专项 suite 加载失败、`0 tests` 执行；原因是运行时导出 `@blackcat/api/order-experience-reviews` 尚不存在。这证明合同 Story 中的模型和 OpenAPI 不能替代真实 API 实现。

### GREEN：API、迁移、兼容和并发

命令：

```text
npx vitest run tests/m12-us-04-rating.spec.ts tests/m12-us-04-postgres.spec.ts tests/m21-us-02-order-experience-reviews.spec.ts tests/m21-us-02-postgres.spec.ts
```

结果：`4 files / 12 tests passed`。

覆盖：

- 订单所有者与跨用户拒绝；无真实客服响应时不生成客服目标；过期请求零写入。
- 整体、单个/多个陪玩和真实客服目标派生；低分无理由保存；严格请求类型与批量上限。
- 伪造目标的原子失败、同目标并发唯一、留言稍后追加且不可覆盖。
- 旧客服评价及留言迁移、旧入口双写兼容。
- 明确同意、五星安全快照、低分与留言排除、Outbox 创建。
- 评价/留言/快照不可变，以及订单状态、金额、钱包流水和资金预留不变。

最终将 M21 合同门禁一并复验：

```text
npx vitest run tests/m21-us-01-review-contract.spec.ts tests/m6-us-00-contract.spec.ts tests/m12-us-04-rating.spec.ts tests/m12-us-04-postgres.spec.ts tests/m21-us-02-order-experience-reviews.spec.ts tests/m21-us-02-postgres.spec.ts
```

结果：`6 files / 24 tests passed`。

## 静态与合同门禁

```text
npm run build
```

结果：TypeScript project references 构建通过。

```text
npm run db:validate
```

结果：运行时 Prisma schema 有效。

```text
npm run quality:routes
```

结果：`168 production operations are documented`。

```text
npm run lint:api-dashboard
```

结果：`0 errors / 28 warnings`，低于仓库既有 `--max-warnings 39` 门禁；新增评价模块无 warning。

```text
git diff --check
```

结果：通过，无空白错误。

## 剩余边界

- `M21-US-03` 的 Discord 低点击评价中心尚未实现。
- `M21-US-04` 的 Worker 幂等投递和好评频道展示尚未实现；本 Story 仅创建不可变同意快照和待投递 Outbox 事实。
- `M21-US-05` 的真实 Guild、移动端、多陪玩混合评价及隐私外部 UAT 尚未执行。
- 仓库既有 `docs/outputs Codex-P0开发TODO.md` 单行镜像漂移和完整业务配置示例的 L1 权限规则基线问题未由本 Story 修改或掩盖。
