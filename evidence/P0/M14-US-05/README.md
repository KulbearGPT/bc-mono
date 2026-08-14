# M14-US-05 验收证据

## Story

- Story：`M14-US-05` RBAC、可访问性与真实员工 UAT 发布验收
- 状态：本地发布候选与真实 L4 浏览器 UAT 已完成；完整权限、人工键盘与签署未完成
- 日期：2026-08-05
- Requirement：`SUP-UX-01; ACCESS-02`
- 验收：`AT-SUX-001` 至 `AT-SUX-007`

## 发布门禁 RED

- `tests/m14-us-05-support-release.spec.ts` 首次执行时，待处理指标错误指向不存在的 `/admin/support`。
- 真实 `/support` 因正在运行 API 返回的旧任务没有新版 `links` 投影而抛出 `TypeError`，页面白屏。
- 375px 真实页面 `documentElement.scrollWidth=713`，客服历史表把整页撑出视口。
- L4 PostgreSQL 聚合把第二 Guild 纳入当前指标：预期今日/进行中/待处理/异常为 `3/1/3/2`，实际为 `4/2/4/3`。
- “进行中订单”计数包含派单、已接单、服务中、待确认四种状态，但原链接只筛 `IN_SERVICE`，真实指标为 1、结果为 0。
- 真实 L4 认领任务后点击“查看完整订单”，共享管理端详情响应没有旧客服投影的 `readiness`，页面再次因直接解引用而白屏。
- 首轮全仓回归为 3 failed / 1018 passed，定位到来源套餐展示名、验收矩阵重建和 M14 fixture 索引缺失。

## 修复

- 待处理任务指标使用真实 `/support?taskFilter=ALL` 路由，覆盖 OPEN、CLAIMED、VERIFIED 与 PENDING_APPROVAL 等全部未终结任务，而非把指标误缩窄为仅待认领。
- Dashboard 对滚动发布期间缺少 `triage/links` 的任务提供最小安全兜底，链接失败关闭而不白屏。
- `.table-shell` 在窄屏内部横向滚动，375px 页面级宽度恢复为 375px。
- Dashboard metrics 的 L1-L4 聚合均先按可信 Actor Guild 隔离，再应用等级/认领范围；PostgreSQL 回归覆盖 L4 第二 Guild 排除。
- 订单列表 API 增加受控 `IN_PROGRESS` 运营筛选组，精确覆盖 `PENDING_DISPATCH / ACCEPTED / IN_SERVICE / PENDING_CONFIRMATION`；OpenAPI 双镜像同步。
- 补齐 M14 七组验收 fixture 与索引，并由脚本重建验收矩阵。
- 保留订单详情来源套餐展示名，技术与审计字段继续默认折叠。
- 认领后订单概览兼容共享管理端详情与旧生命周期投影；客户、中文状态、金额始终优先展示，准备/匹配/自动流程缺失时显示“待补充”，畸形响应失败关闭而不白屏。

## 自动化 GREEN

```text
npm test
Test Files  208 passed (208)
Tests       1023 passed (1023)
包含 npm run build / tsc -b tsconfig.build.json

npm run build -w @blackcat/dashboard
1593 modules transformed; built in 310ms

npm run db:validate
The schema at database/prisma/schema.prisma is valid
```

专项数据库/API/Dashboard 回归还覆盖：任务排序与安全链接、最小认领前投影、订单集合、Dashboard metrics、L4 Guild 隔离、`IN_PROGRESS` 列表筛选、旧任务兼容、窄屏 CSS 和合同镜像。

后续 Dashboard E2E 补验 `DE2E-SUP-008` 已覆盖 L2+ 查看 L1 已认领任务、填写必填结案说明并以 `UNDERLYING_ACTION_COMPLETED` 结案；订单与 FundReservation 事实保持不变。结案入口与自动化验收因此不再是产品实现阻断。

## 真实 L4 浏览器 UAT

- 会话：Sandbox 环境，真实 ACTIVE L4；API 与 Dashboard 重启到本次源码后复验。
- 桌面：订单卡显示真实客户展示名、中文状态、金额、阻塞、下一步和相对/精确时间；详情首屏为“订单处理概览”，技术详情与高级陪玩操作默认折叠。
- 客服页：首屏顺序为班次条、当前任务；旧任务投影缺失时显示“待补充 / 订单频道暂不可用”，无白屏或新控制台错误。
- 真实任务路径：L4 在 Sandbox 认领一条任务，状态由“待认领”变为“处理中”，客服记录认领数变为 1；进入订单处理概览后显示客户、中文状态和 20.0 猫条，缺失生命周期字段安全显示“待补充”。
- 指标：待处理链接恢复全部当前任务；“进行中订单 1”进入 `status=IN_PROGRESS` 后返回 1 条“等待陪玩报名”订单，不再出现计数 1 / 结果 0。
- 375px：任务卡 343px，操作按钮 309px，客服表在自己的 309px 容器内滚动，页面 `scrollWidth=375`。
- 768px：页面 `scrollWidth=768`，队列和首张卡片在首个视口可见，任务摘要单列。
- 读屏语义：跳到主要内容、管理导航、客服工作台、当前任务队列、任务筛选、展开状态、命名任务上下文、指标链接和订单处理概览均可从 DOM 快照识别。

详见 `browser-uat.md`。

## UAT 范围

- 范围决定（2026-08-05）：真实员工 UAT 只覆盖当前业务 Guild，不要求准备第二个真实 Guild；跨 Guild 隔离继续由 PostgreSQL/API 自动化安全回归证明。

## 外部阻断

- 数据库事实为 ACTIVE L1 1 个、DISABLED L2 1 个、无 L3、ACTIVE L4 1 个；无法完成四级真实员工登录矩阵。
- 浏览器驱动的 `press/keypress` 未触发原生按钮；按钮语义、焦点和鼠标展开已验证，真实人工键盘操作仍需签署。
- 结案入口与 `DE2E-SUP-008` Chromium 自动化已经通过；真实员工尚未在 Sandbox 执行结案，且尚无产品、客服和 QA 签署。
- 因其余外部证据缺失，`M14-US-05`、`AT-SUX-001/003/004/005/006/007` 保持 `PENDING_EXTERNAL`，不声称发布完成。第二个真实 Guild 不属于缺失证据。

## 修改文件

- `apps/api/src/admin-directory.ts`
- `apps/api/src/dashboard-metrics.ts`
- `apps/dashboard/src/SupportWorkbenchPage.tsx`
- `apps/dashboard/src/support-workbench.ts`
- `apps/dashboard/src/AdminBusinessPage.tsx`
- `apps/dashboard/src/styles.css`
- OpenAPI、fixture、TODO 双镜像
- M14/M4 回归测试、验收矩阵与本证据目录
