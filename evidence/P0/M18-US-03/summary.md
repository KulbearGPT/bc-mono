# M18-US-03 证据摘要

## 结果

- 状态：DONE（本地运行时与自动化）；真实 Guild 三角色/桌面手机 UAT 归 M18-US-08
- 验收候选：AT-EXP-002、AT-EXP-003、AT-EXP-006
- API / 数据合同：新增最小权限 `welcome_dm.send` 与 `getWelcomeDmContext`；完整 Bot 配置读取仍保持 L3+

## 实现

- 常驻新人入口从一段纯文本升级为品牌 Embed：找陪玩、申请陪玩、真人帮助三条路径与三个稳定按钮；rendered version 升为 4，新建和恢复消息都携带 Embed。
- 公共服务入口现使用 `PUBLIC_WELCOME=90`，下单和返回当前旅程分区说明，不展示余额或隐私事实。
- 四步下单现使用 `PRIVATE_ORDER=75`：每页明确进度；老板需求进入独立引用字段；清单、价格、钱包、提交状态与下一步不再堆在同一正文。
- 新增安全的游戏横幅解析器，覆盖 13 个现有类别；未知标签回退 `other.png`，不接受用户输入文件路径。
- Components V2 新增 Media Gallery 与本地附件能力；游戏横幅在标题/字段之前渲染，随后才是套餐、单点与操作组件。
- 公共入口与报名资格 presentation 从 `service-center.ts` 抽离，facade 保持 2492 行，继续通过 M17 `<2500` 预算。

## RED

```text
npx vitest run tests/m18-us-03-onboarding-order-experience.spec.ts
Test Files  1 failed (1)
Tests       no tests
原因：Cannot find module apps/bot/src/game-banners.js
```

## GREEN

```text
npx vitest run \
  tests/m18-us-03-onboarding-order-experience.spec.ts \
  tests/m10-us-07-order-requirements.spec.ts \
  tests/m10-us-08-service-packages-bot.spec.ts \
  tests/m10-us-09-order-notes-bot.spec.ts \
  tests/m9-us-05-onboarding-bot.spec.ts \
  tests/bot-copy.spec.ts
Test Files  6 passed (6)
Tests       32 passed (32)

npm run quality:bot
lint        0 warnings / 0 errors
format      passed
typecheck   passed
build       passed
pieces      22 discovered
Bot tests   53 files / 311 tests passed
```

## 2026-08-09 新成员迎新私信与 `/welcome` 重发

- 新增 `GuildMemberAdd` 监听：非 Bot 新成员加入后自动收到黑猫品牌私信，内容包含玩家下单、陪玩申请、真人客服和首次使用步骤，并链接到当前 Guild 配置的玩家入口。
- 新增 `/welcome player:@成员`：Discord 先按 `ManageGuild` 限制命令范围，执行时再携带可信 Actor Context 调用统一业务 API；当前最小权限修复见下节，授权成功且目标仍在同一 Guild 后才发送私信。
- 自动与手动路径共用同一 renderer；不自动注册账户、不改变订单或资金状态。目标为 Bot 时跳过；Discord 关闭私信时不在公共频道补发，手动路径返回 ephemeral 操作提示。
- RED：`tests/m18-us-03-welcome-dm.spec.ts` 因 `@blackcat/bot/welcome-dm` 尚不存在而 1 suite failed / 0 tests。
- GREEN：目标 1 file / 5 tests，相关欢迎与配置 5 files / 24 tests 通过；真实 command executor 覆盖 defer → API 授权 → 同 Guild member fetch → DM → ephemeral 结果顺序。
- Bot 完整门禁：lint、Prettier、typecheck、build 通过，24 个 Pieces 被发现，57 files / 333 tests passed。
- 验收追踪矩阵由仓库生成器更新为 302 行，并通过 2 files / 67 tests 的可复现与目标回归。
- 全仓门禁：`npm test` build 通过，248 files / 1241 tests passed。
- 真实 Guild 的新成员加入、DM 开启/关闭及 slash command 注册 UAT 尚未执行，仍归 M18-US-08，不以本地测试替代。

## 2026-08-09 迎新私信 90 密度品牌升级

- 自动迎新与 `/welcome` 重发继续共用同一 renderer；没有新增业务状态、权限或资金路径，仍仅在 API 授权后提供私密导航。
- 私信新增“黑猫陪玩 · 新朋友接待处”品牌署名、原创迎新横幅、6 个清晰分区与 2 个稳定按钮；文案覆盖情绪欢迎、玩法想象、老板路径、陪玩路径、真人客服、服务承诺和三步开始方式。
- 原创横幅由内置 `imagegen` 能力生成；画面使用原创黑猫耳机吉祥物、午夜紫与霓虹青游戏休息室、暖金欢迎光，不含第三方角色、Logo、文字或水印。运行时衍生资产已在后续性能优化中改为 `apps/api/assets/onboarding/welcome.webp`。
- RED：扩充 `tests/m18-us-03-welcome-dm.spec.ts` 后，因旧 renderer 缺少品牌 author、图片附件和新增分区，目标测试为 1 failed / 4 passed。
- GREEN：迎新、下单体验与文案目标回归为 3 files / 13 tests passed；Bot 完整门禁通过 lint、Prettier、typecheck、build 与 24 Pieces 发现，57 files / 333 tests passed；全仓 build 与 248 files / 1241 tests passed。

## 2026-08-09 老板订单频道品牌头图

- 第 1/4 步游戏选择面板最前新增迎新同款原创黑猫横幅；面板刷新或恢复时由同一 renderer 继续携带附件，进入具体游戏后使用原有游戏主题横幅，不另外发送会刷屏的独立图片消息。
- 新增共享的固定品牌素材解析器，订单面板与迎新私信使用同一路径、附件名和 `attachment://` URL；用户输入不能控制文件路径。
- RED：扩充 `tests/m18-us-03-onboarding-order-experience.spec.ts` 后，旧游戏选择面板首项仍为按钮分区，1 failed / 4 passed。
- GREEN：订单、迎新、套餐与既有下单入口相关回归 5 files / 50 tests passed；Bot 完整门禁通过 57 files / 333 tests，24 Pieces、lint、Prettier、typecheck 与 build；全仓 248 files / 1241 tests passed。
- 本地 Bot watch 进程已在变更后启动新运行子进程并重新登录 Discord。使用 Discord Guild Command API 复核，`welcome` 已注册，要求 `ManageGuild`、禁止 DM 使用且没有服务器级权限覆盖；未具“管理服务器”权限的账号不会看到该命令。

## 2026-08-09 横幅分辨率与传输体积优化

- 迎新/订单横幅从 2168×725 PNG 确定性缩放为 1600×535 WebP；13 张游戏横幅从 1774×887 PNG 缩放为 1600×800 WebP。编码使用 quality 84、smart subsample、effort 6，不重新生成或改写画面内容。
- 14 张运行时横幅总大小从 Git 基线 29,042,983 bytes 降至 2,077,754 bytes，减少约 92.8%；单张为 112,494–179,230 bytes，显著低于 550,000 bytes 门禁。
- Bot、Worker、欢迎私信、订单 Components V2、公开派单、UAT 脚本、素材 manifest 与附件名全部切换至 `.webp`；固定映射与未知游戏回退边界不变。
- RED：5 files / 29 tests 中 7 failed，覆盖旧 PNG 映射、旧附件 URL 与缺少 WebP 资产。
- GREEN：同组 5 files / 29 tests passed；发布审计会解析 WebP RIFF 尺寸并强制尺寸、单图体积、完整 13 图集合以及游戏目录无残留 PNG。Bot 完整门禁通过 57 files / 333 tests、24 Pieces、lint、Prettier、typecheck 与 build；API typecheck 通过，API/Dashboard lint 保持既有 38 warnings / 0 errors 基线；全仓 248 files / 1241 tests passed。
- Bot watch 运行时已自动重启；不带 watch 的派单 Worker 已单独正常重启，启动日志为 `worker.started`、`recoveredJobs=0`、待发 Reaction 卡与终态清理均为 0，避免运行时继续引用旧 PNG。

## 2026-08-09 `/welcome` L2 最小权限修复

- 根据真实拒绝审计 `req_e1040ada-57fe-4777-ad27-2c24c4bf91f9` 定位：账号绑定和员工状态正常，但有效等级为 L2；旧手动重发错误借用了 L3 才有的 `bot_config.read`。
- 新增 `welcome_dm.send`，从 L2 起累积授予；`/bot-config` 的 `bot_config.read`、运营写入和安全 Role 权限均未放宽。Discord 侧继续要求 `ManageGuild`，API 继续以可信同 Guild Actor Context 最终授权。
- 新增 `getWelcomeDmContext`：仅返回 `guildId` 与 `publicEntryChannelId`，不返回完整 `values`、`manageableFields` 或其他配置。成功、L1 拒绝、服务身份拒绝及跨 Guild 失败均保留审计，目标为被重发的 Discord 用户。
- Bot 改为先调用专用 API，再获取同 Guild 成员并发送私信；自动迎新路径、品牌 renderer、隐私和业务状态均未改变。
- RED：2 files / 7 tests 中 4 failed，旧 Bot 仍调用 `getBotConfig`，新 API 路径返回 404。
- GREEN：专项 2 files / 9 tests passed；相关发布/追踪回归 4 files / 75 tests passed；Bot 门禁 57 files / 334 tests、24 Pieces、lint、Prettier、typecheck、build 通过；API/Dashboard lint 为既有 38 warnings / 0 errors，Prisma 与 160 条生产 API 路由合同通过；全仓 249 files / 1245 tests passed。
- 验收矩阵由仓库生成器重建为 303 行，`AT-EXP-006` 标记为 `AUTOMATED / COVERED_BY_REGRESSION`；主规格、OpenAPI、交互映射、业务配置 Schema/example/seed 与发布镜像均同步。
- 本地 API/Bot watch 进程已加载变更。以原拒绝账号执行无副作用的专用上下文读取返回 200，只包含两个合同字段；最终运行时验证 request_id：`req_1dfb623b-6c28-44dc-a86f-fb034a1a806f`。实际 `/welcome` 私信投递仍由操作者在 Discord 触发。

## 剩余外部门禁

AT-EXP-003 的真实 Discord 桌面/手机扫读性、图片裁切、按钮换行和三角色签署统一在 M18-US-08 执行；本 Story 未伪造该证据。
