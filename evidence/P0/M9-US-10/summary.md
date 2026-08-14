# M9-US-10 陪玩项目分成覆盖证据

## 合同与实现

- 服务目录后台输入改为默认陪玩分成百分比；API 保留最终单位金额作为订单结算快照，并记录精确 basis points。
- 新增 `player_service_compensation_rules`，以陪玩档案与服务项目唯一约束保存 `PERCENT_BPS` 或 `FIXED_MINOR`，通过 `row_version` 支持后续编辑。
- Dashboard 陪玩列表新增“设置项目分成”，以始终可见的 ACTIVE 项目列表同时展示个人规则、项目默认分成、区服和计费单位；点选一行后单条编辑，已有规则回显版本和值。
- 接单事务在分配陪玩时解析个人覆盖，原子写入 `player_unit_payout_minor` 与 `expected_player_earning_minor`。个人规则不存在时使用目录默认值，已接单订单不追溯。

## 验证记录

- RED：`npx vitest run tests/m9-us-10-player-compensation.spec.ts`，模块不存在，suite failed。
- GREEN：`tests/m9-us-10-player-compensation.spec.ts tests/m4-us-03-dashboard.spec.ts tests/m2-us-03-api.spec.ts`，3 files / 25 tests passed。
- 相关目录与数据库回归：`tests/m1-us-01-db.spec.ts tests/m1-us-01-api.spec.ts tests/m4-us-03-db.spec.ts tests/m2-us-11-bot.spec.ts`。
- `npm run typecheck` 与 `npm run db:validate` 通过；迁移 `000014_player_service_compensation` 已应用到本地开发数据库。
- 真实接单 `req_9f48baa9-e4e6-49ca-a88d-f38e30537a70` 暴露收益快照被金额不可变触发器拒绝。新增迁移 `000016_order_acceptance_payout_snapshot`：仅在同一事务显式授权、且状态从 `PENDING_DISPATCH` 进入 `ACCEPTED` 时，允许更新两个陪玩收益字段；客户单价与订单总额继续禁止修改。数据库与相关回归 13/13、build 通过，迁移已应用到本地开发库。
- 后续真实接单 `req_b8eaea31-805f-48a8-81b0-a2c9a0f2db28` 继续暴露迁移 `000014_player_service_compensation` 漏授运行时表权限，API 读取个人规则时报 `permission denied`。迁移 `000017_player_compensation_runtime_grant` 补充 blackcat_app 的 SELECT/INSERT/UPDATE；RED/GREEN 与数据库回归 9/9，通过同一运行账号实测查询成功，迁移已应用。
- 可见列表回归（2026-08-05）：RED 在新增 Dashboard 门禁后 1/6 失败；GREEN 为 `tests/m9-us-10-player-compensation.spec.ts tests/m4-us-03-dashboard.spec.ts tests/dashboard-card-workspaces.spec.ts` 3 files / 36 tests，通过根级 typecheck 与 Dashboard production build。`INT-D-051`、M9-US-10 backlog 与 `AT-COMP-001` 镜像同步为可见列表交互。
- 批量保存回归（2026-08-05）：确认窗口汇总全部已缓存项目并调用原子批量 API；`tests/m9-us-10-player-compensation.spec.ts` 9 tests passed，覆盖多个项目请求及一条版本过期时整批不写入。
- 批量 PostgreSQL 修复（2026-08-05）：请求 `req_374e09a5-c37b-49de-a76f-9b08b20768a8` 暴露 JSON 批量载入将 `type` 解析为 `text`、无法写入 PostgreSQL `PlayerCompensationType` 枚举的问题；改为按枚举解码。专项测试 10 passed、根级 typecheck 通过，并以本地 PostgreSQL 验证 `jsonb_to_recordset` 可解码 `PERCENT_BPS`。
- 批量 UUID 修复（2026-08-05）：请求 `req_9371f75a-f678-464b-875a-0847994a4002` 暴露 JSON 批量载入把规则关联 UUID 解码为 `text`，在与规则表连接时触发 `uuid = text`。现将三个关联字段在解码阶段声明为 UUID；专项测试 10 passed、根级 typecheck 通过，并以本地 PostgreSQL 验证批量关联可匹配既有规则。
- 草稿确认回归（2026-08-05）：项目分成输入现在即时缓存于当前操作窗口，列表实时标识“草稿已缓存”；点击提交仅打开二次确认窗口，展示项目、原分成、新分成及修改方式，只有“确认并保存”才调用既有单条 upsert API。RED 为新增门禁 1/7 失败；GREEN 为关联 3 files / 37 tests、typecheck、Dashboard production build 和 diff check 通过。

## 验收状态

AT-COMP-001 与 AT-COMP-002 已建立自动化候选。仍需登录 Dashboard 完成真实浏览器 UAT，并用真实陪玩接单验证收益快照，因此 Story 暂不勾选完成。
