# M19-US-04 客服任务与高风险业务刷新

- 状态：DONE（本地运行时与自动化）
- 验收：`AT-STATE-002`、`AT-STATE-003`、`AT-STATE-005`

## 问题与修复

- 原客服工作台只在首次打开时请求任务、班次和汇总；别人认领、陪玩就绪、任务升级或资金决定后会持续显示旧事实。现在可见页面每 5 秒统一重取队列、选中订单、班次/汇总和运营指标；隐藏页面取消 timer，回到前台立即刷新。
- 新增手动“立即刷新”、上次更新时间和非阻断失败提示。刷新失败不清空队列、订单或指标，而是保留上次可信内容。
- 同一页的定时、手动与写后刷新会合并进行；任务和订单查询使用最新请求序列，迟到的旧响应不会覆盖更新事实。
- 认领、备注、升级、结案、礼物核验、礼物批准/拒绝、打卡和自动化暂停/恢复均在成功或冲突后统一回读；失败文案保留可信结果语义并携带 API `request_id`。
- 取消、异常结案、礼物、退款、Adjustment 和客服接管的现有 API/DB/Bot/Dashboard 事务、权限、资金和投影回归未发现新的服务端缺口。

## 验证

- RED：`tests/m19-us-04-support-live-refresh.spec.ts` 因实时刷新模块缺失而 1 suite failed / 0 tests。
- GREEN：新增刷新回归 1 file / 3 tests passed；兼容聚焦 5 files / 18 tests passed。
- 高风险专项：任务、接管、取消、异常、礼物、退款与时间线 25 files / 79 tests passed。
- Dashboard typecheck、Vite production build 通过；API/Dashboard lint 0 errors / 38 条历史 warning（上限 39）；`git diff --check` 通过。
- 全仓：`npm test` → 246 files / 1232 tests passed（含 TypeScript build）。验收矩阵可重现生成 302 rows，追踪/发布门禁 4 files / 78 tests passed。

## 外部边界

真实 L1–L4 登录、两个 Guild、前台/后台切换与五秒收敛时序仍属 `M19-US-05` 外部 UAT；本 Story 不声称已完成人工签署。
