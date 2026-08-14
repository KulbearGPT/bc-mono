# M10-US-08 套餐模板与可编辑陪玩席位

状态：本地候选，真实 Discord Guild 与 Dashboard UAT 尚未执行，因此 Story 保持未完成。

## 验收映射

- `AT-MULTI-008`：套餐版本在单事务中展开为逐席位 `OrderRequirement`，失败零变更。
- `AT-MULTI-009`：客户可只把一个技术席位改为娱乐陪玩并填写“会聊天”等备注，其他席位保持不变，API 切换为 `CUSTOMIZED` 并重新报价。
- `AT-MULTI-010`：L3+ 在 Dashboard 原子创建、发布和退役不可变套餐版本；仍待真实 Dashboard 外部验收。

## 已有证据

- 合同与 RED/GREEN：`evidence/P0/M10-US-08/contract.md`。
- 数据、迁移、API 与 PostgreSQL 原子性：`evidence/P0/M10-US-08/api-data.md`。
- Dashboard 管理与完整回归：`evidence/P0/M10-US-08/admin-dashboard.md`。
- Bot 全回归：35 files / 187 tests passed。
- Dashboard 全回归：27 files / 130 tests passed。
- 仓库全量回归：179 files / 877 tests passed；TypeScript、构建与完整迁移链通过。
- 本地已登录 L4 Dashboard 浏览器只读 UAT 与 Sandbox 迁移修复见 `evidence/P0/M10-US-08/browser-uat.md`；套餐列表和创建 Dialog 实际页面通过，写入型 UAT 仍待确认。

## Discord 点菜式下单交互原型（2026-08-04，待评审）

- 新增可点击 HTML 原型 `outputs/P0开发交付包/01-UIUX/Discord点菜式下单流程原型.html`，用于先评审信息架构，不代表 Bot 运行时或冻结合同已经变更。
- 流程收敛为“选游戏 → 浏览该游戏菜单 → 套餐或单点加入 → 逐席位调整 → 确认清单”；跨游戏必须显式返回游戏入口，套餐、单点及套餐席位替换均按当前游戏隔离。
- 套餐仍是订单需求的快捷生成器：加入后每个席位可独立更换同游戏服务、计费单位和偏好；同时允许继续单点添加陪玩。价格区分目录小计与服务端套餐调整，确认前提示 API 重新报价。
- 浏览器交互核验覆盖：英雄联盟菜单不出现无畏契约或三角洲选项；双席位套餐加入；套餐席位可编辑且替换列表只含英雄联盟服务；单点追加；套餐调整与最终确认金额展示。待产品评审通过后，再同步正式交互映射、验收合同和 Bot TDD 实现。
- 评审修订 v0.2：去除“整张套餐卡可点击”的非 Discord 表现，改为可真实实现的 Components V2 `Container + Section + accessory Button`；每个套餐仅右侧原生按钮可交互，单点项目使用 String Select。浏览器复验覆盖游戏 Section 进入、套餐按钮切换/采用、三席位展开和单点 Select 追加。

剩余门禁：真实 Guild 套餐选择、改单与重启恢复；Dashboard 写入型创建、发布、退役及历史订单解析。

## Dashboard 套餐价改为席位派生（2026-08-04）

- 合同修订：主规格、backlog、OpenAPI、Prisma、交互映射与 `AT-MULTI-010` 已统一为“套餐总价由 API 按每席位目录单价 × 计费单位数派生并固化；Dashboard 只读实时显示且不得提交价格”。`docs/` 与 `outputs/` 镜像同步。
- RED：`npx vitest run tests/m10-us-08-service-packages-dashboard.spec.ts tests/m10-us-08-service-packages-api.spec.ts`，2 files / 12 tests 中 4 failed，证明原表单仍提交价格、API 仍要求价格且没有自动汇总显示。
- GREEN：Dashboard 套餐编辑器移除 `defaultCustomerPriceMinor` 输入和请求字段，随席位项目/单位数实时显示具体猫条金额；套餐列表继续读取 API 返回的具体固化金额。API 严格拒绝客户端价格字段，内存与 PostgreSQL 均按目录版本价格派生，`000028_derived_service_package_prices` 回填历史版本并把价格列收紧为非空。
- 聚焦与关联回归：M10 套餐/单游戏 `9 files / 36 tests`；Dashboard + M10 套餐关联 `26 files / 117 tests`；PostgreSQL 聚焦 `1 file / 6 tests`，全部通过。
- 完整验证：`npm test` → `182 files / 903 tests passed`（包含 TypeScript build）；`npm run build -w @blackcat/dashboard` production build 通过；`npm run db:validate` 通过；`git diff --check` 通过。
- Story 状态：自动化候选通过，但真实员工 Dashboard 创建/发布/退役及 Discord Guild UAT 仍沿用既有外部门禁，因此 `M10-US-08` 保持未完成。
