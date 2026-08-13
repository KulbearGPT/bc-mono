# Blackcat Operations 设计系统

本文记录当前 Dashboard 与 Discord 品牌资产已经实现的视觉约束。运行时事实以 `apps/dashboard/src/styles.css`、实际 React 组件和自动化验收为准；修改 token 或组件行为时，应在同一个 Story 中同步本文与相关测试。

## 1. 设计目标

- 运营界面优先保证高密度信息的可读性、明确的状态层级和可恢复操作，不以装饰性动效掩盖业务事实。
- 默认主题是深色运营台：深海军蓝表面、紫色与青色技术强调、绿色主操作。
- 可选 `cute` 主题是同一信息架构的浅色表达，不得改变权限、字段、动作或状态含义。
- Discord 横幅和吉祥物用于建立品牌识别；Dashboard 的图标、状态色和插图不得代替文本标签或业务状态。

## 2. 事实来源

| 内容 | 权威位置 |
|---|---|
| Dashboard token、响应式规则与主题覆盖 | `apps/dashboard/src/styles.css` |
| 页面结构和交互状态 | `apps/dashboard/src/**/*.tsx` |
| 黑猫角色母版 | `apps/api/assets/brand/mascot-character-reference.png` |
| 游戏横幅映射 | `apps/api/assets/game-banners/manifest.json` |
| 可访问性与视口门禁 | `tests/e2e/` 与 Dashboard 相关测试 |

仓库当前没有 `design-system/pages/` 页面级覆盖文件。不得引用不存在的页面规范；页面差异应首先由共享 token、现有组件和验收合同约束。

## 3. 默认深色主题

### 3.1 核心颜色

| 角色 | 当前值 | CSS token |
|---|---:|---|
| 应用背景 | `#050812` | `--surface-app`, `--surface-page` |
| 卡片/面板 | `#0d1423` | `--surface-card`, `--surface-panel` |
| 柔和表面 | `#111b2d` | `--surface-soft`, `--surface-muted` |
| 抬升表面 | `#141f33` | `--surface-raised` |
| 主文字 | `#edf4ff` | `--text-primary` |
| 次文字 | `#9cabc0` | `--text-secondary` |
| 弱文字 | `#718096` | `--text-muted` |
| 细边框 | `#22314a` | `--border-soft` |
| 紫色强调 | `#7968ff` | `--accent-electric` |
| 青色强调 | `#25b7bb` | `--accent-cyan` |
| 霓虹青 | `#20c9b7` | `--accent-neon-cyan` |
| 业务主操作 | `#16a86b` | `--color-accent` |
| 危险操作 | `#dc3e4f` | `--color-destructive` |

状态不能只靠颜色表达。成功、等待、告警、失败和禁用状态必须同时提供可读标签、图标或辅助文本。

### 3.2 字体

- 正文：`Inter`，回退到系统无衬线与中文系统字体。
- 展示标题：`Orbitron`，回退到 `Rajdhani`、`Arial Narrow` 和无衬线字体。
- 技术字段：`JetBrains Mono`，回退到系统等宽字体。
- 等宽字体只用于 ID、时间、金额对账值和技术元数据；大段说明保持正文字体。
- 字体资源不可用时必须保持布局和可读性，不能依赖远程字体加载才能操作。

### 3.3 圆角、阴影与动效

| token | 值 | 用途 |
|---|---:|---|
| `--radius-sm` | `8px` | 标签、紧凑控件 |
| `--radius-md` | `12px` | 按钮、输入、普通卡片 |
| `--radius-lg` | `18px` | 主要面板、详情区 |
| `--radius-xl` | `24px` | 页面级容器 |
| `--shadow-sm` | `0 1px 2px rgb(0 0 0 / 24%)` | 控件层级 |
| `--shadow-md` | `0 12px 34px rgb(0 0 0 / 28%)` | 卡片与浮层 |
| `--shadow-lg` | `0 26px 76px rgb(0 0 0 / 42%)` | 模态与最高浮层 |

- 常规反馈使用 150–180ms 过渡；复杂进入动效不是 P0 必需能力。
- hover 不得引发布局位移。active 可使用轻微 `translateY(1px)`，但不能改变可点击区域。
- 必须遵守 `prefers-reduced-motion: reduce`；禁止把 GSAP、React Native、Expo、Reanimated 或触觉反馈当成当前 Web 实现依赖。

## 4. Cute 浅色主题

`data-theme="cute"` 只改变视觉 token：暖白背景、粉色与薄荷绿强调、Nunito 风格展示字体和更大圆角。它不得：

- 改变列表集合、字段顺序、权限或 capability；
- 隐藏技术上必须显示的状态、金额或审计信息；
- 用粉色或装饰性图形推断用户、角色或业务含义；
- 造成深色主题已有的焦点、对比度和响应式门禁失效。

## 5. 组件规则

### 5.1 按钮与链接

- 所有可操作控件最小尺寸为 `44 × 44px`，使用明确动词；纯图标按钮必须有可访问名称。
- 主按钮只用于页面当前最重要且允许执行的动作。危险动作使用危险色、影响预览和确认步骤。
- disabled 必须同时反映视觉状态和真实不可操作状态；服务端仍要复核权限与版本。
- Discord 深链只在 Guild、频道和对象归属完整可信时可激活，不生成 `/channels//` 一类残缺链接。

### 5.2 表单

- label 与输入建立程序化关联；错误信息靠近字段并使用 `role="alert"` 或等价语义。
- 输入、Select、Textarea 最小高度 44px。技术 ID 只在合同允许手工输入时出现；Discord Channel、Role 和可见目录使用受限 Select。
- 金额同时显示单位；CAT 与 USD 不能依靠颜色或上下文猜测。最终金额与 capability 来自 API。
- 提交中禁止重复动作；失败保留可信旧数据、`request_id` 和可恢复下一步。

### 5.3 卡片、表格与详情

- 卡片和表格是同一服务端集合的两种投影，切换不得重新定义权限、排序、分页或可用动作。
- 业务名称、中文状态、时间、阻塞原因和下一步优先；UUID、row version 与原始枚举放在技术详情区。
- 空、加载、错误、权限不足和无结果是不同状态，必须使用不同文案。
- 表格在窄屏可转换为卡片或允许受控横向滚动，不得截断唯一操作入口。

### 5.4 导航、浮层与反馈

- 侧栏与顶栏层级分别使用既有 `--z-sidebar`、`--z-topbar` 语义；浮层必须管理焦点、Escape 和背景交互。
- 页面提供 skip link；键盘焦点使用清晰的青色外环，不能只靠 hover。
- Toast 不能承载唯一错误信息；关键结果应在相关面板内持续可见，并包含恢复动作或 request ID。

## 6. 响应式与可访问性

至少验证以下宽度：`375px`、`768px`、`1024px`、`1440px`。同时满足：

- 最小支持宽度 320px，页面不产生非必要的整页横向滚动；
- 375px 下主要任务无需缩放，可触达主操作且不被固定导航遮挡；
- 768px 下侧栏、表格、卡片和详情面板按现有断点收敛；
- 1024px 与 1440px 下信息密度增加，但阅读顺序不改变；
- 正文对比度至少 4.5:1，重要非文本控件至少 3:1；
- 所有流程可仅用键盘完成，并具有稳定焦点顺序和读屏名称；
- `prefers-contrast: more` 和 `prefers-reduced-motion` 覆盖不能被页面样式抵消。

## 7. 品牌资产

- 黑猫角色必须遵循 `apps/api/assets/brand/README.md`，不得改变头型、眼睛比例、尾巴数量或连接位置。
- 游戏横幅必须使用原创题材元素和 `manifest.json` 的稳定显示名映射，不复制第三方 Logo、角色、地图或宣传图。
- 静态资产是当前品牌系统的一部分，并非禁用项；但每个资产都要有明确用途、替代文本、尺寸/格式约束和版权边界。
- 装饰图像不能包含唯一业务信息。Discord 附件加载失败时，消息文本仍应完整表达标题、状态和下一步。

## 8. 交付检查

- [ ] 使用现有 token，未在页面内另造近似颜色、阴影或圆角体系。
- [ ] 深色和 cute 主题展示相同事实、权限与动作。
- [ ] 加载、空、错误、禁用、成功和陈旧状态均可辨识。
- [ ] 交互控件最小 44px，键盘焦点与读屏名称完整。
- [ ] `prefers-reduced-motion`、`prefers-contrast` 和四个基准视口通过。
- [ ] 卡片/表格、Dashboard/Discord 均消费统一 API 事实，不在 UI 重算权限或金额。
- [ ] 品牌资产遵循角色母版、原创边界和运行时 fallback。
- [ ] 相关 Dashboard 测试、E2E 覆盖检查和目标回归已执行并记录。
