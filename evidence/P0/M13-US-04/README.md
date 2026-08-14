# M13-US-04 验收证据

## Story

- Story：`M13-US-04` 跨页一致性、可访问性与发布验收
- 状态：本地候选与真实 L4 浏览器 UAT 已完成；完整 L1–L4 权限与人工签署未完成
- 日期：2026-08-05
- Requirement：`LST-01; ACCESS-02`
- 验收：`AT-LST-001` 至 `AT-LST-008`

## 已完成的可执行范围

- 自动遍历七资源全部排序字段及 `asc/desc`，校验 Dashboard 选项与 API 白名单一致。
- 通过共用分页器验证完整排序矩阵的唯一 ID 连续性和升降序均 `NULLS LAST`。
- 复用 M13-US-02/03 回归覆盖查询绑定游标、URL 恢复、请求竞态、CARD/TABLE parity 和分页重置。
- 服务端渲染七页 TABLE/窄屏行式列表，验证排序控件可命名、行可聚焦且详情入口可达。
- 本地数据库已成功部署 `000031` 至 `000034`；本地 API 与 Dashboard 均返回 HTTP 200。
- 员工亲自完成 Discord 登录后，以 Sandbox L4 会话执行七页真实浏览器 UAT：50 个排序字段/方向组合全部成功，桌面 CARD/TABLE 记录与详情保持一致。
- 768px 下六个有数据页面渲染语义表格，375px 下按相同记录数降级为行式 `article`；礼物请求空集合在两种断点均显示空状态且无错误。
- 订单筛选、快速排序切换与刷新恢复通过：`status=COMPLETED` 返回 3 条，最终 `amountMinor asc` 顺序为 `20.0, 20.0, 40.0` 猫条，刷新后 URL、筛选、排序、TABLE 和结果顺序不变。
- CARD/TABLE 首条记录均为 `P-3810D50D`，两种视图打开同一详情且无权限或加载错误。实际浏览器记录见 `browser-uat.md`。
- 卡片视图工具栏与首排卡片之间恢复统一 `12px` 间距；真实陪玩页测得 toolbar bottom `705.046875`、grid top `717.046875`，页面 `scrollWidth=viewport=625`，订单与其余业务卡片共用同一规则。
- 2026-08-08 修复七页卡片动作被大块内容推到首屏外的问题：详情、编辑、删除、审批、取消等记录动作统一前移到标题后的“可用操作”区域，CARD/TABLE/窄屏列表复用同一渲染器；七页动作矩阵 14 个组件门禁、7 个 1280×720 Chromium 门禁、33 files / 168 tests Dashboard 回归、根 typecheck 与 production build 通过，并保存 CARD/TABLE 共 14 张截图。详细证据见 `action-visibility-plan.md` 与 `action-visibility-results.md`。

## 外部阻断

- 浏览器驱动的 `press/keypress` 在本环境中未改变焦点或触发原生按钮；真实键盘按键仍需人工签署。语义控件、可聚焦行和详情入口已有自动化与 DOM 证据，但不替代人工键盘结论。
- 当前数据库只有 L1 与 L4 为 ACTIVE，L2 为 DISABLED，且没有 L3；当前登录会话仅为 L4，因此无法完成四级真实员工会话矩阵。
- 真实员工 UAT 只覆盖当前业务 Guild，不要求第二个真实 Guild；跨 Guild 隔离继续由 `AT-LST-008` 的 API/数据库 fixture 自动化证明。
- 需要产品/运营/QA 对真实数据的默认与至少三种排序、双视图、空状态、详情和可用动作签署。
- 因上述 fixture、人工键盘与签署证据尚未取得，本 Story 保持未勾选，且不声称发布完成。

## 修改文件

- `tests/m13-us-04-release.spec.ts`
- `tests/m13-us-03-dashboard-collections.spec.ts`
- `apps/dashboard/src/styles.css`
- `outputs/Codex-P0开发TODO.md` 与 `docs/Codex-P0开发TODO.md`
- `evidence/P0/acceptance-matrix.csv`
- 本证据目录
