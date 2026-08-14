# Dashboard 全量代码审查整改计划

## 1. 范围与基线

- 修复对象仅为 `apps/dashboard`、Dashboard 测试、Dashboard 验收证据及必要的合同同步。
- API 与 Bot 只作为只读合同和能力事实来源；本批次不修改 API 或 Bot 运行时代码。
- 分支：`codex/dashboard-full-review-fixes`。
- 基线：`f32f6e651636b62576096c4523e6f3d873a2d269`。
- 所有业务写继续通过统一 API；Dashboard 不计算余额、权限、对象归属或业务状态迁移。

## 2. 修复批次与 Story 映射

### 批次 A：客服工作台与最新对象一致性

- Story/验收：`M14-US-03`、`M14-US-04`、`M19-US-03`、`M19-US-04`；`AT-SUX-004`、`AT-SUX-006`、`AT-REV-005`、`AT-STATE-003`。
- 先建立失败测试：readiness 投影缺字段不得白屏；任务切换期间不得把新任务与旧订单组合；详情乱序响应不得覆盖当前对象。
- 最小实现：运行时投影归一化、任务/订单绑定选择、latest-request gate、页面级错误边界。
- 完成条件：专项测试、Dashboard typecheck/build 与客服 Chromium 场景通过。

### 批次 B：资金权限、幂等与币种

- Story/验收：`M15-US-05`、`M16-US-03`；`AT-DOP-004`、`AT-REV-001`、`AT-REV-004`、`AT-REV-005`。
- 先建立失败测试：无 `wallet.top_up`/`wallet.external_refund` 时不得显示可执行按钮；冲正和追加型写重试复用相同幂等键；阈值按 capability currency 显示。
- 最小实现：为每种资金动作独立 capability；复用可重试写指纹；统一 CAT/合同币种格式化。
- 完成条件：L1/L2/L3 组件与 E2E 权限矩阵、钱包回归及严格 lint 通过。

### 批次 C：结算作废与管理列表分页

- Story/验收：`M6-US-02`、`M6-US-04`、`M15-US-08`、`M16-US-03`；`AT-SET-004`、`AT-SET-006`、`AT-REV-005`。
- 先建立失败测试：已批准/已导出批次没有替代批次时不能提交作废；列表可消费 `nextCursor`；员工列表超过 100 条仍可到达。
- 最小实现：状态相关作废表单、替代批次输入及不可提交说明；结算/周报/员工列表游标分页和失败恢复。
- 完成条件：结算组件、请求构造、列表分页及 Chromium 场景通过。

### 批次 D：能力可见性、路由和错误状态

- Story/验收：`M4-US-02`、`M13-US-04`、`M14-US-05`、`M16-US-04`。
- 无执行权限操作展示禁用原因；L1 继续使用已存在的 StaffTask 升级链路。
- 未授权直达显示 403，未知路由显示 404；API 状态不得硬编码为在线。
- 网络错误必须结束 loading/busy 并提供重试与 `request_id`。
- 通用审批页依赖的 OpenAPI 路由当前没有运行时实现；不在 Dashboard 伪造成功路径，保留为 API 前置阻断。

### 批次 E：业务语义与前端结构

- Story/验收：`M15-US-04`、`M15-US-06`、`M19-US-03`；`AT-DOP-003`、`AT-DOP-005`、`AT-STATE-001`。
- readiness 文案统一为客户不参与、全体有效陪玩决定开始。
- 删除或降级旧 `availability` 主展示；Archive 文案统一为“归档”。
- 派单超时字段存在合同冲突：先同步事实来源，未统一前不改变运行时业务值。
- 抽取金额、状态、异步请求和页面状态公共模块；清理严格 lint 报警与确认无引用的样式。

## 3. 提交策略

每个批次单独使用 Conventional Commit，不把不相关业务修复混入同一提交：

1. `docs(dashboard): plan full review remediation`
2. `fix(dashboard): harden support workbench state`
3. `fix(dashboard): enforce financial action capabilities`
4. `fix(dashboard): complete settlement administration`
5. `fix(dashboard): restore route and action feedback`
6. `refactor(dashboard): align business presentation primitives`
7. `docs(todo): record dashboard review remediation evidence`

## 4. 最终门禁

- `npx eslint apps/dashboard/src --max-warnings 0`
- `npm run typecheck -w @blackcat/dashboard`
- `npm run build -w @blackcat/dashboard`
- Dashboard 相关 Vitest 全量
- Chromium Dashboard E2E 全量
- `git diff --check`
- 每个修复均有失败基线、GREEN 输出和可复核证据；外部 UAT 或 API 前置未完成时明确保持未完成，不以自动化替代。

## 5. 完成状态（2026-08-11）

- [x] 批次 A：客服工作台与最新对象一致性
- [x] 批次 B：资金权限、幂等与币种
- [x] 批次 C：结算作废与管理列表分页
- [x] 批次 D：能力可见性、路由和错误状态
- [x] 批次 E：业务语义与前端结构
- [x] 最终 Dashboard 静态与 Chromium 全量门禁
- [ ] 通用审批页：阻断于 API 运行时缺失；不属于本 Dashboard-only 分支可安全完成的范围
- [ ] legacy 派单字段从 API/Bot 合同彻底移除：需要独立跨端合同 Story；本分支已在 Dashboard 隐藏
