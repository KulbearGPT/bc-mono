# M14-US-05 Browser UAT

日期：2026-08-05  
环境：`http://localhost:5173`，Sandbox，ACTIVE L4，单 Guild

| 场景 | 结果 | 证据摘要 |
|---|---|---|
| 客服页首屏 | PASS | 班次条后直接显示“当前任务”，2 条待认领任务；历史与指标在后 |
| 旧任务兼容 | PASS | 缺新版投影显示待补充和频道不可用，无白屏；修复后无新 console error |
| 认领前摘要 | PASS | 展开后出现命名 `任务上下文` region，并明确只读与权限边界 |
| 待处理指标 | PASS | `/support?taskFilter=ALL` 恢复后“全部”筛选按钮为 pressed，口径覆盖所有未终结任务 |
| 进行中指标 | PASS | 指标 1 → `/admin/orders?status=IN_PROGRESS` → 1 条“等待陪玩报名” |
| 订单卡与详情 | PASS | 真实客户名、中文状态、金额、阻塞、下一步、更新时间；技术详情默认闭合 |
| 375px | PASS | 页面宽 375 / scrollWidth 375；表格滚动限于内部容器 |
| 768px | PASS | 页面宽 768 / scrollWidth 768；任务摘要单列，首卡在首屏 |
| 默认桌面 | PASS | 订单与详情无页面级溢出，信息层级清晰 |
| 语义与名称 | PASS | skip link、main、导航、队列、筛选、展开状态、region、指标链接均有名称 |
| 真实键盘激活 | BLOCKED | 浏览器驱动 press/keypress 未触发按钮；需人工键盘签署 |
| L1-L4 | BLOCKED | 当前只有 ACTIVE L1/L4；L2 disabled、无 L3。真实 UAT 仅要求当前业务 Guild |
| 任务认领与订单上下文 | PASS | L4 认领后状态变为处理中、认领数变为 1；订单概览显示客户、中文状态、金额并对缺失生命周期字段兜底 |
| 任务结案自动化 | PASS | `DE2E-SUP-008` 已验证 L2+ 结案，且订单与 FundReservation 事实不变 |
| 真人结案与签署 | BLOCKED | 真实员工尚未在 Sandbox 执行结案；产品、客服、QA 尚未签署 |
