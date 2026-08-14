# M13-US-04 Summary

M13-US-04 已形成可复核的本地发布候选：七类列表的排序配置、全部字段双方向、跨页唯一性、空值顺序以及七页键盘可达性均由自动化覆盖；员工亲自登录后的真实 L4 浏览器 UAT 又覆盖了 50 个排序组合、CARD/TABLE parity、375/768/桌面、筛选、快速切换、URL 恢复与详情一致性。

2026-08-06 修复卡片视图工具栏与卡片网格紧贴的问题：七类集合共用 `12px` 垂直间距，聚焦回归 10 tests 与 Dashboard production build 通过，真实陪玩页测量为 12px 且无横向溢出。

2026-08-08 修复七页卡片记录动作位于 720px 首屏之外的可发现性回归：CARD、桌面 TABLE 和窄屏行式列表现在复用同一“可用操作”渲染器，卡片动作位于标题之后、摘要之前；集合级新建按钮保持在页面标题区。未通过基线为 1 file / 14 failed，修复后目标与关联 4 files / 57 tests、七页 Chromium 7/7、Dashboard 33 files / 168 tests、根 typecheck、production build 与 14 张双视图截图均通过。证据：`action-visibility-plan.md`、`action-visibility-results.md`。

## 验证

- M13-US-02/03/04 聚焦回归：`3 files / 19 tests passed`。
- M13 与追踪门禁：`5 files / 87 tests passed`。
- API/数据库关联回归：`4 files / 27 tests passed`。
- `npm run typecheck`：通过。
- Dashboard production build：通过，`1593 modules transformed`。
- `npm run db:validate`：Prisma schema valid。
- 本地 `prisma migrate deploy`：`000031` 至 `000034` 成功部署。
- 最终全仓串行回归：`202 files / 998 tests passed`。
- 验收矩阵：`259 acceptance rows`，`AT-LST-004` 与 `AT-LST-008` 仍为 `PENDING_EXTERNAL`。
- 真实浏览器：七页 `50/50` 排序组合通过；六个有数据页面在 768px 为语义表格、375px 为相同记录数的行式列表；礼物请求空状态通过。
- L4 订单筛选/竞态/恢复：`COMPLETED=3`，最终金额顺序 `20.0, 20.0, 40.0` 猫条，刷新前后记录一致；CARD/TABLE 首条及详情均为 `P-3810D50D`。

## 发布状态

真实 L4 在当前业务 Guild 的多视口浏览器验证已执行。当前 fixture 缺少 ACTIVE L2、L3，浏览器驱动也不能产生可信的真实键盘按键证据；L1–L3、人工键盘和产品签署仍未执行，因此 `M13-US-04` 不是完成状态，也不构成发布批准。第二个真实 Guild 不属于发布条件，跨 Guild 隔离由 API/数据库自动化回归证明。
