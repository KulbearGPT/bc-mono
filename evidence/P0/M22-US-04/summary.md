# M22-US-04 客服辅助送礼模式 B 自动化证据

状态：`AUTOMATED_CANDIDATE / PENDING_EXTERNAL`

验收：`AT-GIFT2-005`

## 已实现边界

- Discord 消息右键命令“协助此老板送礼”只提交目标消息作者、Guild、频道和消息证据，不读取或上传消息正文。
- API 依据可信 Actor Context 和同 Guild Discord 绑定解析付款老板；客户端不接受 `senderId`、`receiverId`、内部客户 ID 或内部客服 ID。
- `gift.assist` 为专用 L1 累积权限。最终确认由客服本人填写必填授权原因和六位 TOTP；challenge 绑定客服、`permissions_version`、Guild、老板与授权消息，十分钟过期、最多五次失败、只能消费一次。
- 最终事务重新校验客服权限、TOTP、客户绑定、陪玩、礼物版本/价格和钱包可用余额；成功时原子创建一条 `STAFF_ASSISTED` GiftRequest、一笔老板 FundReservation、一条 `GIFT_REVIEW` 任务与审计事实。错误、过期、重放和余额不足不创建业务事实。
- 匿名模式只改变外部发送者展示；内部保留老板付款人和客服执行者两类独立归属，TOTP 不进入数据库、审计、任务上下文或错误。

## RED 证据

- 冻结模式 B 合同后执行 `pnpm exec vitest run tests/m22-us-04-staff-gift-assist-contract.spec.ts`：`1 file / 4 failed / 1 passed`。缺失项为四个 API operation、数据模型、权限/交互/验收追踪及运行时实现。
- 收紧 Discord 证据字段后，API 专项为 `1 file / 1 failed / 4 passed`，证明伪造的非 Snowflake 授权频道此前会被接受；加入服务端格式校验后转绿。
- 将新权限纳入完整业务配置镜像时，合同专项为 `1 file / 1 failed / 4 passed`，证明 `gift.assist` 尚未进入业务配置示例/Schema；同步四级有效权限与 L1 MFA 自助登记后转绿。

## GREEN 证据

- `pnpm exec vitest run tests/m22-us-04-staff-gift-assist-bot.spec.ts`：初次 `1 file / 5 tests passed`；加入外部 UAT 保留门禁后由最终全仓覆盖为 `6 tests passed`。
- `pnpm exec vitest run tests/m22-us-04-staff-gift-assist-contract.spec.ts tests/m22-us-04-staff-gift-assist-api.spec.ts tests/m22-us-04-staff-gift-assist-postgres.spec.ts tests/m22-us-04-staff-gift-assist-bot.spec.ts tests/m22-us-02-standalone-gift-api.spec.ts tests/m22-us-02-standalone-gift-postgres.spec.ts tests/m22-us-03-bot-gift-entry.spec.ts tests/m22-us-03-guild-uat-harness.spec.ts`：加入 UAT 保留断言前 `8 files / 30 tests passed`；最终全仓覆盖更新后的全部专项测试。
- `npm run quality:routes`：`192 production operations exactly match OpenAPI`。
- `pnpm exec vitest run tests/api-review-route-parity.spec.ts tests/m0-us-01.spec.ts tests/m1-us-01-api.spec.ts tests/m4-us-06-api.spec.ts`：`4 files / 40 tests passed`。
- `npm run lint:api`、`npm run lint:bot`、`npm run typecheck`、`npm run build`：全部退出码 `0`。
- `npm run db:validate`：Prisma schema valid；`npm run pieces -w @blackcat/bot`：发现新命令与三个新 interaction handlers。
- 全仓 `npm test` 首轮：`293 files passed / 4 files failed；1470 tests passed / 4 tests failed`。四项均为新增合同带来的库存/fixture/追踪快照门禁，随后已更新，最终全仓结果在本 Story 提交前复验并记录于 TODO。
- `node scripts/build-p0-acceptance-matrix.mjs .`：重建 `317` 行验收追踪矩阵；受影响门禁 `6 files / 87 tests passed`。
- 最终聚焦合同/API/PostgreSQL/Bot/业务配置回归：`11 files / 53 tests passed`。
- 最终 `npm test`：`297 files / 1475 tests passed`。

## 主要修改文件

- 合同：`outputs/Discord陪玩业务Bot最小原型设计开发文档.html`、`outputs/P0开发交付包/01-UIUX/*`、`02-API/openapi.yaml`、`03-数据模型/*`、`05-业务配置/*`、`06-开发计划/backlog.csv`、`07-验收测试/*` 及 `docs/` 镜像。
- 数据与 API：`database/prisma/schema.prisma`、`database/prisma/migrations/000044_staff_assisted_gifts/migration.sql`、`database/seed/seed-data.csv`、`apps/api/src/gifts.ts`、`apps/api/src/authorization-policy.ts`。
- Discord Bot：`apps/bot/src/staff-assisted-gifts.ts`、`service-center-api-client-*`、`bot-api-validation.ts`、消息命令与三个 Sapphire interaction handlers。
- 测试：`tests/m22-us-04-staff-gift-assist-{contract,api,postgres,bot}.spec.ts` 及受新增模型、路由库存影响的既有门禁更新。

## 未完成的外部门禁

真实 Guild 中的客服/老板桌面与手机交互、真实 TOTP、权限撤销、错误次数、重放与匿名展示仍需按 `human-uat-runbook.md` 由真人执行并签署。自动化探针不得替代该证据；完成前不得勾选 Story 或声明发布完成。
