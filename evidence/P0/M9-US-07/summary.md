# M9-US-07 Provider 退役与 Railway 发布门禁证据

生产环境校验和 Railway 手册不再要求 Funding Adapter、Provider secret 或 sandbox provision；Web/Bot/Worker 仍保留迁移、健康检查和分离启动命令。

`tests/m9-us-07-release.spec.ts`、生产环境校验、构建和全量回归作为候选证据；Railway 部署 ID 与真实 Guild 结果由外部 UAT 补录。

## Dashboard 上线视觉审查补充（2026-08-02）

- RED：新增 `tests/dashboard-release-ui.spec.ts` 后首次运行 3/3 失败，分别复现服务版本表单无结构化网格、六个已发布 Dashboard Page 混用 inline layout、以及缺少统一 panel/table/state/响应式门禁。
- GREEN：`AdminBusinessPage`、`CustomerProfilePage`、`OperationsPage`、`SecurityPage`、`SettlementPage`、`SupportWorkbenchPage` 全部迁移到同一套 `dashboard-page`、panel、form、table、metric 与 state 原语；服务/礼物/风险/陪玩审批表单统一为 label-on-top 自适应网格，checkbox、错误、按钮组和详情区不再随字段长度漂移。
- 响应式浏览器复验：服务版本表单在 375px 为 1 列、768px 为 2 列、1024px 为 2 列、1440px 为 3 列；四个宽度均为 `document.scrollWidth === viewport`。移动端导航由纵向 16 项列表改为局部横向工作区栏，375px 下 sidebar 高度由约一屏收敛为 211px，页面本身无横向滚动。
- 页面抽查：客服工作台、账户安全、系统运营、周期结算和服务目录在真实本地员工会话下均渲染新结构，1440px 检查无页面级横向溢出；服务目录和结算页面完成截图级人工复核。
- 自动化：定向 Dashboard 回归为 6 files / 37 tests；追踪与视觉复验为 2 files / 66 tests；`npm run typecheck`、`npm run build -w @blackcat/dashboard` 通过；最终 `npm test` 为 151 files / 751 tests 全通过。一次并发全量运行中的既有 Railway 子进程测试出现空输出，单测复验 14/14 通过，随后完整套件复跑全绿。
- 实际修改：`apps/dashboard/src/AdminBusinessPage.tsx`、`CustomerProfilePage.tsx`、`OperationsPage.tsx`、`SecurityPage.tsx`、`SettlementPage.tsx`、`SupportWorkbenchPage.tsx`、`styles.css`、`tests/dashboard-release-ui.spec.ts`、`tests/m6-us-04-dashboard.spec.ts`。
- 本补充只改善 Dashboard 上线可用性并加固自动化门禁，不替代 `AT-ONB-005`、真实 Discord Guild、Railway 部署与最终候选签署；`M9-US-07` 继续保持未完成。

## 陪玩业务科技主题精修（2026-08-02）

- 在既有清晰运营布局上增加克制的 gaming-tech 表层：紫青能量渐变主按钮、HUD 页面分隔线、玻璃面板顶部能量线、操作面板角标、数据卡角标、表格微光 hover、当前导航能量态与品牌低频呼吸光；没有改变页面结构、数据密度、业务交互或服务端事实。
- 动效继续受全局 `prefers-reduced-motion: reduce` 约束；高饱和色只用于 CTA、细线和状态高光，正文、字段、表格仍保持浅色高对比。
- 浏览器人工复验：1470px 服务目录/创建版本表单无页面级横向溢出；375px 为单列表单、sidebar 高 211px、`document.scrollWidth === viewport === 375`，科技装饰未引入裁切或额外滚动。
- RED/GREEN：`tests/dashboard-release-ui.spec.ts` 新增 gaming-tech 视觉合同后 1/4 失败，CSS 实现后 4/4 通过；`npm run typecheck`、Dashboard production build 和 `git diff --check` 通过。
- 全量回归：默认高并发运行中既有 Railway 启动子进程出现一次空输出，其他 150 files / 751 tests 通过；该文件单独复验 14/14 通过，随后限制为 4 workers 的完整套件为 151 files / 752 tests 全通过。此偶发风险与本次纯 CSS 变更无代码路径交集，但继续如实保留。

## Tactical Ops 深色运营终端候选（2026-08-03）

- RED：扩展 `tests/m4-us-01-dashboard-ui.spec.ts` 与 `tests/dashboard-release-ui.spec.ts` 后首次运行 2 files / 9 tests，其中 3 tests 失败，分别锁定导航分组与状态轨、字体 token，以及深色工作区、切角面板、查询工具条、查询空状态和表格 hover 视觉合同。
- GREEN：Dashboard 切换为克制的深色 Tactical Ops 视觉语言；导航按“指挥中心 / 业务运营 / 财务控制 / 系统治理”分组，顶栏加入只展示真实会话事实的 `API ONLINE / 环境 / Role + Level` 状态轨。日常业务页统一使用石墨面板、切角边界、查询模块标签、等宽数据表和行级青色状态线，没有新增虚构指标、浏览器端权限判断或业务动作。
- 可访问性与响应式：保留 44px 触控目标、键盘 focus 和 `prefers-reduced-motion`；移动端导航继续局部横向滚动。真实浏览器复验 375、768、1024、1440px，四个宽度均为 `document.documentElement.scrollWidth === clientWidth`，没有页面级横向溢出。
- 自动化与构建：RED 后聚焦视觉合同 2 files / 9 tests 全通过；全部 Dashboard 回归 15 files / 69 tests 全通过；`npm run typecheck`、`npm run build -w @blackcat/dashboard`、`git diff --check` 通过。Dashboard production build 为 CSS 42.42 kB（gzip 10.17 kB）、JS 317.96 kB（gzip 94.51 kB）。
- 实际修改：`apps/dashboard/src/App.tsx`、`apps/dashboard/src/styles.css`、`tests/m4-us-01-dashboard-ui.spec.ts`、`tests/dashboard-release-ui.spec.ts`、`outputs/Codex-P0开发TODO.md`、本证据文件。
- 本候选仅改变表现层与导航信息架构；`M9-US-07` 的真实员工 Dashboard UAT、Railway 部署、Discord Guild 验收和最终签署仍未完成，因此 Story 保持未勾选。

## Bot 长文案集中管理（2026-08-03）

- 范围：仅抽离欢迎词、完整状态说明、客户通知和带变量的错误反馈；“确认”“取消”“刷新”等短组件标签继续就近维护。本次没有引入 i18n、语言检测或运行时文案配置。
- RED：新增 `tests/bot-copy.spec.ts`，首次运行因 `apps/bot/src/bot-copy.ts` 尚不存在而失败。
- GREEN：新增强类型 `BOT_COPY` / `botCopy` 文案目录，接入新人入口、注册/陪玩申请反馈、礼物余额与提交说明、订单匹配/客服/预留说明、订单选项恢复及派单失败通知；展示内容和业务分支保持不变。
- 验证：聚焦回归为 5 files / 12 tests；随后 `npx vitest run tests/*bot*.spec.ts` 为 23 files / 112 tests 全通过。`npm run typecheck -w @blackcat/bot`、根级 `npm run build` 与 `git diff --check` 通过。Bot workspace 没有独立 `build` script，误调用只返回 `Missing script: build`，已改用仓库真实构建门禁复验。
- 实际修改：`apps/bot/src/bot-copy.ts`、`onboarding.ts`、`gifts.ts`、`service-center.ts`、三个 interaction handler 与 `tests/bot-copy.spec.ts`。真实 Discord 文案复核仍属于既有外部 UAT，Story 保持未完成。

## 黑猫电竞 Discord 品牌文案候选（2026-08-03）

- 语气规则：采用“可靠业务事实 + 克制猫舍氛围”，每条重要回复最多一个品牌化开场；金额、订单状态、处理边界、时间和 `request_id` 保持明确，不使用隐喻替代关键事实。
- 覆盖范围：欢迎与登记、陪玩申请、订单频道创建、匹配与预留、客服介入、完成确认、取消、申诉、礼物、接单以及常见失败恢复。Discord Role、权限映射、业务状态和金额逻辑均未修改。
- RED：`tests/bot-copy.spec.ts` 先要求“欢迎来到黑猫电竞”、新客欢迎、猫舍匹配提示和猫爪礼物回执，旧机械文案下 1/2 失败。
- GREEN：Bot 文案目录和调用点更新后，`npx vitest run tests/*bot*.spec.ts` 为 23 files / 112 tests 全通过；`npm run typecheck -w @blackcat/bot`、根级 `npm run build` 与 `git diff --check` 通过。
- 本轮仅形成 Discord 端候选文案；真实 Guild 中的换行、Embed 密度、移动端阅读与运营语气仍需外部 UAT，因此 `M9-US-07` 保持未完成。

## 黑猫陪玩 Bot 文案与信息层级精修（2026-08-07）

- 范围：统一新人入口、下单四步向导、服务中心、钱包/Profile、订单生命周期、陪玩工作台、候选池和礼物流程的标题、段落与重点操作标签；采用“emoji 标题 + 空行 + 事实分组 + 下一步”的层级。颜文字仅在低风险欢迎语出现一次，资金、状态、权限、失败原因与 `request_id` 不使用装饰替代事实。
- RED：先扩展 `tests/bot-copy.spec.ts`，要求黑猫品牌标题、一次性欢迎颜文字、Markdown 分组、礼物预留事实和三个入口按钮；旧实现为 3 tests 中 2 failed。
- GREEN：集中式 `BOT_COPY` / `botCopy` 与全部高频 `MessageSpec` 标题完成统一，常驻新人消息版本由 2 提升至 3；custom ID、visibility、Actor Context、订单状态、资金预留/扣除语义和 API 调用均未修改。关联 `AT-ONB-003`、`AT-UI-001/002/003/005`、`AT-PRF-005`。
- 验证：聚焦文案测试 3/3 通过；完整 `npm run test:bot` 为 48 files / 261 tests，其中 47 files / 259 tests 通过，剩余 2 个失败是改动前已存在的 `M17-US-08` refresh 路由与 700 行门禁基线。`npm run typecheck -w @blackcat/bot`、根级 `npm run build`、`npm exec -- prettier --check apps/bot/src` 与 `git diff --check` 通过。标准 `npm run lint:bot` 因本地安装缺少 `eslint` / `@eslint/js` 无法启动，未伪报通过。
- 实际修改：`apps/bot/src/bot-copy.ts`、`onboarding.ts`、`service-center.ts`、`service-center-profile.ts`、`gifts.ts`、`selection-discord.ts` 及对应 Bot 展示测试。本轮仍需在真实 Guild 复核 Embed/Components V2 换行、移动端密度和运营语气，因此 `M9-US-07` 保持未完成。

## Dashboard 动态表头补齐（2026-08-03）

- 根因：`AdminBusinessPage` 和 `OperationsPage` 根据 API DTO 动态收集列名，但 `table-labels` 未覆盖服务目录等新增字段，所有未命中字段都错误地显示成相同的“数据字段”。
- RED：扩展 `tests/dashboard-table-labels.spec.ts` 后，`offeringKey` 首个断言即以“数据字段”失败；新增服务目录完整字段集合门禁，要求无通用兜底且中文标签互不重复。
- GREEN：补齐服务目录、订单、陪玩、礼物、资金及运营任务常用字段；英文 API 字段继续通过 `title` Tooltip 保留。未知字段兜底改为 `未映射字段：<原字段>`，保证异常可识别并推动后续补表。
- 验证：表头聚焦 1 file / 3 tests、Dashboard 全量专项 16 files / 75 tests 全通过；根级 typecheck、Dashboard production build 和 `git diff --check` 通过。
- 实际修改：`apps/dashboard/src/table-labels.ts`、`tests/dashboard-table-labels.spec.ts`、本证据与开发 TODO。真实员工浏览器 UAT 仍未替代，Story 保持未完成。

## Dashboard 筛选面板光效定位（2026-08-03）

- 根因：科技主题的 `.content-panel::before` 负责顶部能量线，而 `.filter-bar::before` 又负责 `QUERY FILTERS` 标题；后者覆盖文字内容时仍继承前者的宽高、渐变和阴影，导致光效随标题下移。
- RED：视觉合同要求标题伪元素显式清除能量线属性，并由独立 `.filter-bar::after` 将渐变固定在 `top: -1px`；旧样式下 1/7 失败。
- GREEN：标题与光效拆分为两个伪元素，可爱主题继续隐藏科技能量线。视觉聚焦 2 files / 11 tests、Dashboard production build 与 `git diff --check` 通过。
- 实际修改：`apps/dashboard/src/styles.css`、`tests/dashboard-release-ui.spec.ts`、本证据与开发 TODO。真实浏览器截图复核仍属于外部 UAT，Story 保持未完成。

## 本地 Pilot 能力反复关闭修复（2026-08-03）

- 根因：根级 `npm run dev` 固定加载 `.env.example`，其中 `PILOT_PHASE=CORE_ORDER_AND_GIFTS`；本地 `.env` 的 `PILOT_PHASE=OFF` 从未进入 API 进程，因此每次重启后 M6 页面都会再次显示“功能暂未开放”。
- RED：`tests/m0-us-01.spec.ts` 要求开发命令按 `.env` 优先、`.env.example` 兜底加载，旧脚本 1/9 失败。
- GREEN：开发命令改为 `dotenv -e .env -e .env.example`；无本地文件时仍有 checked-in 默认值，有本地配置时显式覆盖。相关 3 files / 16 tests、全仓 typecheck 与 diff check 通过；本地 API/Bot/Dashboard 已重启，API 3000、Vite 5173 与 Sapphire ready 均正常。
- 此修复只改变本地开发启动配置优先级，不放宽生产 Railway 的显式 Pilot 门禁。`M9-US-07` 外部发布验收状态不变。

## Pilot 全阶段开放（2026-08-04）

- 产品决定改为开放全部已实现阶段；本地 `.env`已为 `PILOT_PHASE=OFF`，并将 `.env.example`、`.env.production.example` 和 Railway Sandbox 部署手册统一到同一值。在当前策略中，`OFF` 表示关闭 Pilot 阶段限制，不是关闭功能。
- 运行时校验输出 `['CORE_ORDER','GIFTS','REFERRALS','M6']`；`GET /health` 返回 `OK`，`GET /ready` 返回 `READY`，数据库与配置依赖均为 `READY`。
- 本地 API、Worker、Bot、Dashboard 按当前四进程启动脚本重启成功；`npx vitest run tests/m5-us-06-pilot-features.spec.ts tests/m4-us-01-dashboard.spec.ts tests/m6-us-04-dashboard.spec.ts` 为 3 files / 19 tests 全部通过。
- Railway CLI 返回 `No linked project found`，因此未猜测项目或改写任何外部变量。真实 Railway `web` 服务仍需将 `PILOT_PHASE=OFF` 并重新部署后验证 capabilities；`M9-US-07` 保持未完成。

## Pilot 运行时限制退役（2026-08-05）

- 产品决定不再通过部署变量裁剪已实现功能。生产 API 固定使用 `createPilotFeaturePolicy('OFF')`，始终向 Dashboard/Bot 提供 `CORE_ORDER`、`GIFTS`、`REFERRALS`、`M6`；Railway 遗留的 `PILOT_PHASE=CORE_ORDER` 或 `CORE_ORDER_AND_GIFTS` 不再被读取。
- `PILOT_PHASE` 已从生产环境校验、开发/生产示例和 Railway 手册移除。历史策略构造器仍保留用于旧 Story 的隔离测试，但不再接入生产启动路径。
- `BUSINESS_ENV=SANDBOX` 从未参与功能隐藏，本轮继续保留 Dashboard/Bot 的测试资金提示；权限、Guild scope、step-up、状态和资金规则均未放宽。
- RED：扩展 `tests/m9-us-07-release.spec.ts` 后 2/2 失败，分别捕获生产配置仍要求 Pilot 变量、Railway 手册仍要求配置该变量。
- GREEN：发布/环境关联回归 5 files / 28 tests；API、Bot、Dashboard 功能开关与导航关联回归 8 files / 53 tests；`npm run typecheck` 和 Dashboard production build（1593 modules）通过。
- 重新部署 Web/API 后功能入口才会在外部环境生效；真实员工 Dashboard 与 Discord Guild UAT 尚未执行，因此 `M9-US-07` 继续保持未完成。

## Dashboard 业务卡片工作区与详情浮层（2026-08-04）

- 范围：陪玩、服务目录和服务套餐三个工作区由宽数据表统一为与订单目录相同的信息卡片流；卡片提供中文状态、项目摘要、关键业务字段、内部编号及既有操作入口，并以“查看详情”在原位置打开浮层，避免跳到页面底部。
- 详情：陪玩继续使用既有 API 详情；服务目录与套餐使用已受当前工作区权限裁剪的列表快照展示详情，不新增客户端领域判断或服务端端点。字段标题经既有中文映射显示；套餐席位对象在详情中序列化显示，避免出现 `[object Object]`。
- RED/GREEN：新增 `tests/dashboard-card-workspaces.spec.ts`，首次运行在旧表格实现下失败；实现卡片/浮层路径后，`npx vitest run tests/dashboard-card-workspaces.spec.ts tests/m10-us-08-service-packages-dashboard.spec.ts tests/m10-us-03-api.spec.ts` 为 3 files / 14 tests 全通过；`npx vitest run tests/dashboard-*.spec.ts tests/m10-us-03-api.spec.ts tests/m10-us-08-service-packages-dashboard.spec.ts` 为 6 files / 27 tests 全通过。
- 构建门禁：`npm run typecheck -w @blackcat/dashboard`、`npm run build -w @blackcat/dashboard`、`git diff --check` 均通过。独立浏览器核验环境没有 Dashboard 登录会话，真实员工会话下的截图/操作 UAT 仍待补录；这不改变既有外部门禁状态。
- 实际修改：`apps/dashboard/src/admin-business.ts`、`AdminBusinessRoute.tsx`、`AdminBusinessPage.tsx`、`styles.css`、`tests/dashboard-card-workspaces.spec.ts`。

## Dashboard 服务套餐版本化编辑补齐（2026-08-04）

- 根因：套餐合同明确要求不可变版本，页面却只暴露“创建新套餐版本”和“发布/退役”，没有将已有套餐作为新版本草稿打开的编辑入口，造成运营端看起来无法编辑。
- GREEN：卡片增加“编辑套餐（创建新版本）”。该入口预填稳定代码、展示名称、说明、套餐总价与有序席位；提交仍调用既有 `POST /api/v1/admin/service-packages` 创建版本，绝不原地覆写历史版本、席位或订单。发布选择仍由运营人员显式勾选。
- 验证：先扩展 `tests/m10-us-08-service-packages-dashboard.spec.ts`，旧实现为 2/6 失败；实现后套餐/卡片聚焦 2 files / 10 tests、Dashboard 回归 5 files / 23 tests、Dashboard typecheck、production build 与 `git diff --check` 均通过。

## Dashboard 四类对象详情重排（2026-08-04）

- 根因：用户、陪玩、服务目录与服务套餐的详情浮层共用 `Object.entries` 原始字段转储，造成单列超长留白、显示名 DTO 被标成未映射字段、套餐席位缺少阵容结构；问题与 API 数据、权限或金额语义无关。
- RED：扩展 `tests/dashboard-card-workspaces.spec.ts`，为四类对象分别要求客户概览、陪玩支持范围、目录价格/计费、套餐席位与语义化标题；旧实现为 8 tests 中 4 failed。
- GREEN：增加四类只读详情视图与统一响应式视觉原语。服务目录突出 API 返回的客户单价、计费单位、最低购买量及默认分成；套餐总价继续只读取 API 派生字段，席位逐条展示目录快照、单位数和默认偏好；未新增客户端计价、过滤、状态迁移或权限判断。
- 验证：`npx vitest run tests/dashboard-card-workspaces.spec.ts tests/m4-us-08-dashboard.spec.ts tests/m4-us-03-dashboard.spec.ts tests/dashboard-table-labels.spec.ts tests/m10-us-08-service-packages-dashboard.spec.ts` 为 5 files / 41 tests 全通过；`npm run typecheck`、`npm run build -w @blackcat/dashboard` 与 `git diff --check` 通过。production build 输出 CSS 74.43 kB（gzip 15.95 kB）、JS 365.35 kB（gzip 106.38 kB）。
- 实际修改：`apps/dashboard/src/AdminBusinessPage.tsx`、`apps/dashboard/src/styles.css`、`tests/dashboard-card-workspaces.spec.ts`、`outputs/Codex-P0开发TODO.md` 与本证据文件。真实员工会话下的桌面/移动端截图与操作 UAT 尚未补录，因此 `M9-US-07` 保持未完成。
