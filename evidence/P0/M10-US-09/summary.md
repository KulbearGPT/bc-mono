# M10-US-09 本地实现候选

日期：2026-08-04

## 已实现

- 新迁移为稳定 `ServicePackage` 回填并固化 `gameCode` / `gameName`，混合游戏历史数据会中止迁移。
- 套餐公开列表支持稳定游戏代码过滤，并返回套餐游戏展示事实。
- 套餐创建只接受同游戏有效目录版本；既有稳定代码的新版本不能改变游戏归属，失败保持事务零写入。
- 既有订单需求换项受原席位游戏约束，跨游戏改写在写入事件、订单金额或版本前失败；返回游戏菜单可新增另一游戏的独立需求。
- 修复 PostgreSQL 席位更新语句对状态与时间参数的歧义推断；套餐席位更换项目、修改人数、时长、偏好或移除不再因 `42P08` 在预写阶段失败。
- Dashboard 套餐编辑器先锁定游戏，只提供该游戏的服务目录席位；复制版本恢复稳定游戏。
- Discord 草稿完全收敛为原型四步：新单直接选择游戏；套餐以 Components V2 Section 右侧按钮预览；单点先 Select 预览再显式加入；清单按游戏分组编辑；最终确认后才创建资金预留。旧优先陪玩、整单备注、草稿取消/申诉和旧确认控件不再混入向导。
- 所有价格仍由统一 API 派生；套餐任一增删改进入 `CUSTOMIZED` 并按目录小计报价。

## TDD 证据

- 运行时 RED：`npx vitest run tests/m10-us-09-game-scoped-ordering-api.spec.ts`，`1 file / 3 tests failed`，分别暴露未过滤套餐、混合游戏套餐可写入、跨游戏换项可写入。
- Dashboard RED：`npx vitest run tests/m10-us-08-service-packages-dashboard.spec.ts`，新增单游戏编辑测试失败。
- Discord RED：`npx vitest run tests/m10-us-08-service-packages-bot.spec.ts`，新增四步流程与 Components V2 Section 测试失败。
- 多游戏 RED：`npx vitest run tests/m10-us-09-game-scoped-ordering-api.spec.ts`，暴露 API 仍把“订单”误限制为单游戏；修订为套餐单游戏、订单可含多游戏独立需求。
- 聚焦 GREEN：API、PostgreSQL、Dashboard、Bot 共 `5 files / 26 tests passed`。
- 相关回归：`npx vitest run tests/m10-us-07*.spec.ts tests/m10-us-08*.spec.ts tests/m10-us-09*.spec.ts`，`10 files / 43 tests passed`；新增 Components V2 真实 Builder 序列化单测后 Bot 文件为 `7 tests passed`。
- `npm run typecheck`：通过。
- `npx prisma validate --schema database/prisma/schema.prisma`：通过。
- `git diff --check`：通过。
- PostgreSQL RED：`npx vitest run tests/m10-us-08-service-packages-postgres.spec.ts`，新增套餐席位更新用例稳定复现 `inconsistent types deduced for parameter $3`；显式转换枚举与时间参数后 GREEN 为 `1 file / 6 tests passed`。
- 当前 Sandbox 订单 `P-DBDE4FB0` 以回滚预演方式执行相同更新路径，成功推导订单版本 `3 → 4`、席位版本 `1 → 2`，未写入业务数据。
- 全仓 `npm test` 最终复验构建通过，`182 files / 898 tests passed`。

## 剩余门禁

- `AT-MULTI-011` 仍需真实 Discord Guild 验证游戏选择、套餐/单点组件、重启恢复和 Discord 平台组件限制。
- `AT-MULTI-012` 仍需真实 Dashboard 浏览器验证游戏切换时席位清空、复制版本和错误反馈。
- 2026-08-05 本地 Sandbox 请求 `req_49ec91b3-7542-470d-8b62-270afdc8b570` 暴露运行库仍停在 `000026`，`LIST_SERVICE_PACKAGES` 因缺少 `service_packages.game_code/game_name` 失败。失败的 `000027_game_scoped_service_packages` 记录已用 `MIGRATION_DATABASE_URL` 标记 rolled back 后重新部署成功；现有 `UAT_ESCORT_20260804` 已回填为 `LOLNA`，聚焦 API/Bot/Postgres/合同回归 `4 files / 18 tests passed`。
- 真实 Discord Guild 仍需验证 Components V2 游戏/套餐按钮、单点预览后加入、跨游戏独立新增、四步恢复和提交，因此 Story 保持未完成。

## 第二步需求备注增量（2026-08-08）

- 主规格、backlog、交互映射、界面文案和 `AT-MULTI-011` 已统一为：第二步游戏菜单提供“填写需求备注”按钮，该单字段 Modal 保存整单需求；第三步的“席位偏好”仍是独立事实。`outputs/` 与 `docs/` 镜像逐字一致。
- Bot 菜单显示当前备注和填写/修改按钮；`custom_id` 携带订单、游戏和期望版本，Modal 提交只通过统一 `updateOrderDraft` 路径保存，成功或版本冲突刷新后都返回原游戏菜单；陈旧窗口不覆盖新备注。最终确认页同步展示整单需求备注。
- RED 1：`npx vitest run tests/m10-us-09-order-notes-bot.spec.ts` 为 `1 file / 2 tests failed`，暴露第二步无按钮、无备注投影且 Modal 无游戏返回上下文。
- RED 2：增加最终确认断言后为 `1 failed / 3 passed`；增加陈旧 Modal 恢复断言后为 `1 failed / 4 passed`。
- GREEN：目标文件 `1 file / 5 tests passed`；聚焦回归 `6 files / 43 tests passed`；`npm run typecheck -w @blackcat/bot`、`npm run build` 和 20 个 Sapphire Pieces 发现通过；HTML 原型内联脚本通过 `new Function` 语法校验；`git diff --check` 通过。
- Bot 全回归：`npm run test:bot` 为 `48 files passed / 1 failed`、`283 tests passed / 2 failed`。两项失败均是已记录的 M17-US-08 非关联门禁：`bc:order:{id}:refresh:v2` 旧期望路由尚未解析，以及 `service-center-buttons.ts` 为 707 行而门禁要求小于 700。本增量一度把 `service-center.ts` 推过 2500 行，已将纯 Modal 构造器抽到 `service-center-order-notes.ts`，复验为 2495 个 `split` 行且 M17-US-07 门禁恢复通过，没有留下新回归。
- `npm run quality:bot` 在第一步环境阻断：本地未安装声明的 `eslint` 与 `prettier` 可执行文件（`sh: eslint: command not found`）；后续可用门禁已如上拆分执行。
- 未完成门禁不变：尚未在真实 Discord Guild 点击按钮、提交 Modal 并复验重启/冲突恢复，所以 `M10-US-09` 仍保持未勾选。
