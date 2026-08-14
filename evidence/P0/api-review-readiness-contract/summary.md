# Readiness 现行合同一致性证据

## 范围与冲突

- Story：`codex/api-review-readiness-contract`
- 审查发现主规格旧章节、发布检查表、验收 fixture 和发布演示仍要求客户与陪玩分别确认，但同一主规格 M19、backlog、OpenAPI、交互映射、现行 M10/M19 验收和 API 运行时均明确客户无 readiness 写动作。
- 按事实来源优先级停止运行时修改，先把主规格内部旧叙述与全部发布引用统一到已批准的 M10/M19 规则：客户只读查看逐名进度，所有当前有效陪玩分别确认本人后，最后一名就绪原子触发 `ACCEPTED -> IN_SERVICE`。
- 未修改 Bot 或 Dashboard 源码，也未在本 Story 修改数据库迁移或 API 运行时。

## RED

- 新增 `tests/api-review-readiness-contract.spec.ts` 后为 1 file / 4 failed / 1 passed。
- 失败分别证明：主规格与 AGENTS 仍写两方就绪；`AT-RDY-002/003`、fixture 与 UAT 检查表仍等待客户；数据合同仍把旧聚合列当数据库开始条件；发布原型仍包含客户 `setOrderReadiness` 按钮。

## GREEN

- 主规格、AGENTS、数据模型说明、状态约束、验收用例、fixture、验收计划、UAT 检查表、界面文案、核心交互原型、两份演示与索引已统一。
- `AT-RDY-002` 改为部分有效陪玩就绪不开始；`AT-RDY-003` 改为最后一名有效陪玩就绪只开始一次。
- fixture 改为逐名 `participants[].readyAt`，移除 `WAITING_CUSTOMER`、`WAITING_BOTH` 与 `customerReadyAt` 测试事实。
- Prisma 对 `CUSTOMER_READY_CONFIRMED` 与 `customerReadyAt` 明确标注仅为历史/旧数据兼容，不代表当前客户操作；状态约束要求数据库守卫检查所有当前有效 `order_participants.ready_at`。
- 发布原型不再向客户展示 readiness 写按钮，客户页面只提供刷新逐名准备进度。

## 验证

- `npx vitest run tests/api-review-readiness-contract.spec.ts`：1 file / 5 tests 全通过。
- 重建 `evidence/P0/acceptance-matrix.csv`：308 条验收记录。
- M10/M19/合同/追踪联合回归：7 files / 87 tests 全通过。
- 所有编辑的 `outputs/` 与 `docs/` 发布镜像逐字节一致。
- `git diff --check`：通过。

## 后续运行时阻断

- 当前 PostgreSQL readiness 路径仍为兼容旧数据库触发器，在全体陪玩就绪时把派生时间写入 `customer_ready_at`；该值并非客户事实。数据库基线触发器也仍检查旧的两列。
- 该问题必须由下一独立运行时 Story 通过追加迁移和 API 测试修复；本合同 Story 不声称运行时已完成。
