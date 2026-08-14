# API 静态质量与兼容性门禁证据

## 范围

- Story：`codex/api-review-quality-compatibility`
- 范围限定为 API 生产源码、API 合同/验收镜像和测试基础设施；未修改 Bot 或 Dashboard 源码。
- 目标是消除 API 静态告警和无效代码，确认运行时路由与 OpenAPI 一致，并用全量回归证明既有业务合同未被前序审查修复破坏。

## 未通过基线（RED）

- 新增 API 静态质量门禁后得到 `0 errors / 27 warnings`，主要为重复 import、未使用 helper/import 以及无意义的异常重抛。
- 首轮全量回归为 `260 passed / 18 failed` test files、`1369 passed / 24 failed` tests。失败集中在：TODO 镜像未同步、已移除的通用审批创建 operation 仍残留于验收矩阵、旧 M2 fixture 未携带现行 `guildId`、旧路由数量断言未计入审批决定接口、已退役 first-wins 派单测试仍期待运行时注册，以及静态门禁并行执行超时。
- 第二轮全量回归的唯一失败是服务套餐 PostgreSQL 测试在共享 TCP 端口启动失败；业务断言为 `277 files / 1387 tests` 全通过，6 个数据库断言因数据库未启动而跳过。

## 实施结果

- API 生产源码清除全部 27 个 ESLint warning；删除无调用 helper/import 与无意义异常重抛，公开估价投影改为显式字段白名单，降低未来误泄露陪玩收益字段的风险。
- 根质量脚本新增 `lint:api`，并把 API/Dashboard 联合 lint 的告警预算从 39 收紧为 0；新增 Vitest 静态门禁，防止 API warning 回归。
- 保留 M11 选人池作为唯一派单写入口；旧 `dispatch` store 仅用于迁移/历史读取，不重新注册已退役的 first-wins 路由。
- 使用仓库生成器重建 308 条验收追踪矩阵，移除已删除 `createApprovalRequest` operation 的残留引用；179 个生产 operation 与 OpenAPI 双向完全一致。
- 补齐旧测试 fixture 的现行 Guild 事实，更新安全写路由清单为 106，并同步 `docs/` 与 `outputs/` TODO 镜像。
- PostgreSQL 服务套餐测试限制为只监听测试私有 Unix socket，消除并行运行时共享 TCP 端口碰撞。

## 最终验证

- `npm run lint:api`：通过，0 errors / 0 warnings。
- `npm run lint:api-dashboard`：通过，0 errors / 0 warnings。
- `npm run typecheck -w @blackcat/api`：通过。
- `npm run build`：通过。
- `npm run quality:routes`：通过，`179 production operations exactly match OpenAPI`。
- `npx vitest run tests/m5-us-01-traceability.spec.ts`：1 file / 63 tests 全通过，验收矩阵可复现。
- `npx vitest run tests/m10-us-08-service-packages-postgres.spec.ts`：1 file / 6 tests 全通过。
- `npx vitest run`：278 files / 1393 tests 全通过。
- `git diff --check`：通过。

## 模块边界审查与剩余债务

- API 生产源码约 40,451 行。当前最大模块为 `orders.ts` 4,520 行、`selection-pools.ts` 2,810 行、`service-lifecycle.ts` 2,024 行、`security.ts` 1,924 行、`admin-order-actions.ts` 1,923 行、`gifts.ts` 1,814 行。
- 这些文件已形成明显的职责和变更冲突热点，但本 Story 不做跨领域大拆分：它们同时承载内存/PostgreSQL store、领域变换、API 注册及兼容导出，直接重排会扩大公开导入和事务边界风险。
- 建议后续按独立 Story 逐域拆为 `domain`、`store-memory`、`store-postgres`、`routes` 与 `projection`，每次保持 facade 导出和 OpenAPI 不变，并为文件体量/函数复杂度建立类似 Bot/Dashboard 的结构门禁。该债务不影响本轮业务正确性结论，但会提高后续修改成本，按 P2 维护性风险保留。
