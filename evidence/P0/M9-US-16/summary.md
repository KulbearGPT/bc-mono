# M9-US-16 客服选人派单

## 行为

- 新增 `dispatch.manual`，最低 L2 客服主管；L1 只可查看订单和提交升级，不可直接派单。系统自动派单保留独立 `dispatch.execute` 和 `SYSTEM_JOB` Actor 边界。
- Dashboard 待派订单显示“客服派单”，打开时从统一 API 实时读取 ACTIVE、AVAILABLE、ONLINE、游戏/服务标签匹配且无活动订单的候选。
- 客服可选一至三人；不选时发送给全部当前合格池。显式人选在提交时重新校验，任一人已失效则整次拒绝，不静默回退其他人。
- 每次只创建一轮 90 秒抢单；陪玩仍需点击接单，第一个成功接单者获得订单，不强制指派。

## 验证

- RED：`tests/m9-us-16-staff-dispatch.spec.ts` 初始 3/3 失败，缺少定向候选筛选、L2 权限、候选 API 和 Dashboard 表单映射。
- GREEN 定向：M9-US-15/16、Dashboard 和 API 关联回归 4 个文件 / 28 个测试通过；`npm run typecheck` 通过。
- 合同：新增 `AT-DSP-017/018`、`manualDispatchOrder`、`listManualDispatchCandidates`、`dispatch.manual` 权限和 M9-US-16 backlog/TODO，并同步 outputs/docs 镜像；验收矩阵重建为 223 项，合同联检 6 个文件 / 101 个测试通过。
- 最终 `npm test -- --run`：160 个测试文件 / 794 个测试全部通过；`npm run db:validate` 与 `npm run build` 通过。

## 状态

Dashboard 自动化候选已完成；待真实 Dashboard 会话和 Discord Guild 执行定向/全池派单 UAT。Bot 客服入口不混入本 Story，作为下一个独立 Story 复用同一 API。
