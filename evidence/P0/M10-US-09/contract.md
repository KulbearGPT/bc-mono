# M10-US-09 合同证据

- 日期：2026-08-04
- Story：`M10-US-09` 按游戏点菜式下单与单游戏套餐约束
- 验收：`AT-MULTI-011`、`AT-MULTI-012`、`AT-MULTI-013`
- 范围：仅规格与目标合同；不包含数据库迁移、API、Dashboard 或 Discord Bot 运行时实现。

## 冻结规则

1. 客户先选择游戏，服务和套餐均由 API 按稳定游戏代码过滤。
2. 稳定套餐只属于一个游戏；游戏归属由 API 从全部席位引用的目录版本派生，客户端不能自报。
3. 套餐创建、新版本和既有席位换项均拒绝跨游戏改写，并保持原子零写入；套餐自身始终为单游戏。
4. 草稿中的“单独加陪玩”新增的是 `OrderRequirement` 需求席位，不提前指定实际陪玩；返回游戏选择后可为同一订单新增另一游戏的独立需求。
5. 任一套餐定制切换为 `CUSTOMIZED`，套餐调价归零，由 API 按最终目录行重新报价。

## TDD 与验证

- RED：`npx vitest run tests/m10-us-09-game-scoped-ordering-contract.spec.ts`，结果为 `1 file failed / 2 tests failed / 1 test passed`；缺失 Story、追踪项、游戏过滤及单游戏数据字段。
- GREEN：`npx vitest run tests/m10-us-09-game-scoped-ordering-contract.spec.ts tests/m10-us-08-service-packages-contract.spec.ts tests/m10-us-08-service-packages-admin-contract.spec.ts tests/m10-us-01-contract.spec.ts`，结果为 `4 files / 8 tests passed`。
- 格式与数据合同：OpenAPI YAML 解析通过；交互映射 `119` 行、backlog `98` 行、验收合同 `240` 行且列宽一致；目标 Prisma schema validate 通过；`git diff --check` 通过。

## 修改文件

- `outputs/Discord陪玩业务Bot最小原型设计开发文档.html` 及 docs 镜像
- `outputs/P0开发交付包/01-UIUX/交互映射.csv` 及 docs 镜像
- `outputs/P0开发交付包/02-API/openapi.yaml` 及 docs 镜像
- `outputs/P0开发交付包/03-数据模型/schema.prisma` 及 docs 镜像
- `outputs/P0开发交付包/06-开发计划/backlog.csv` 及 docs 镜像
- `outputs/P0开发交付包/07-验收测试/acceptance-cases.csv` 及 docs 镜像
- `outputs/Codex-P0开发TODO.md` 及 docs 镜像
- `tests/m10-us-09-game-scoped-ordering-contract.spec.ts`

## 后续实现状态

- 同一 Story 的本地运行时候选现已补齐迁移回填、API 过滤、跨游戏改写拒绝与多游戏独立新增、Dashboard 选择约束和 Discord 四步菜单，详见 `summary.md`。
- 仍需真实 Guild 与 Dashboard UAT；Story 保持未完成状态。
