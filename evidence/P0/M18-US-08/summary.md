# M18-US-08 证据摘要

## 结果

- 状态：IN_PROGRESS；自动化与真实频道样例完成，具名三角色/双宽度 UAT 未完成
- 验收：AT-EXP-001 自动化覆盖；AT-EXP-002、AT-EXP-003、AT-EXP-004、AT-EXP-005 保持 `PENDING_EXTERNAL`
- 数据迁移：无
- 发布结论：fail-closed，不声称 M18 或 P0 已发布完成

## RED 与修复

首次 `npm test` 为 242 files / 1219 tests，其中 8 项失败：

- M18 backlog 使用不存在的 `updateOrderNotes`，已按 OpenAPI 和真实 Bot 调用修正为 `updateOrderRequirement`。
- M18/Reaction 验收新增 fixture 引用未进入 fixtureIndex，补齐 409/403/5xx、三角色、多陪玩订单和独立九需求候选池合成事实；两份镜像保持一致。
- M18 与派单状态图新增 5 条外部用例未进入 UAT 清单，现逐条登记；外部用例总数由 75 更新为 80，状态不被伪造为通过。
- API 质量门禁唯一 error 为 `selection-pools.ts` 的 `prefer-const`，已做无行为变化修复；既有 38 warning 保持在当前允许预算内。
- 新增 release audit 后首次全量仅矩阵缺少新测试引用，重新生成 297 行矩阵后恢复字节级可重生。
- 2026-08-10 角色母版门禁首次运行 1 failed / 2 passed：`apps/api/assets/brand/README.md` 尚不存在。补齐角色设定图、头顶与尾巴约束、派单 PNG 尺寸/体积检查后恢复 3/3。

## 2026-08-10 视觉与角色二次校准

- 使用内置 imagegen 逐张重绘 16 张运行时资产：迎新 1 张、派单/流单 2 张、游戏/服务横幅 13 张；保持现有文件名、运行时映射和宽高比例，不改变业务状态、权限、资金或消息行为。
- 用户提供的 1280×720 角色设定图已保存为 `apps/api/assets/brand/mascot-character-reference.png`，并成为唯一角色母版。所有主角统一为圆胖短身、大圆金眼、圆滑头顶和从后腰连接的单条粗尾巴；欢迎与派单初稿曾把正面参考中的尾巴误判为头顶毛束，已逐张返修并复查。
- 色调从近黑橙紫调整为中性蓝调傍晚，以海军蓝、长春花蓝、青蓝和暖金为主；减少大面积纯黑、粉色和花卉装饰。标题改为圆润粗体并逐字保留目录名称。
- 欢迎图保持 1600×535 WebP（130872 bytes）；13 张项目图保持 1600×800 WebP quality 84（133570–234798 bytes）；两张派单 PNG 保持 1774×887（1743876、1841214 bytes）。
- 视觉检查覆盖猫头顶、尾巴连接、角色比例、标题原文、题材辨识和额外猫形象；`聊天 / 小游戏` 卡牌上的第二套小猫图标已改为猫爪、星星、骰子和拼图。
- 该校准只形成自动化与本地视觉候选，不替代 `AT-EXP-002`–`005` 的真实 Guild 三角色、桌面/手机具名 UAT；Story 和发布门禁继续 fail-closed。

## 真实频道视觉样例

- 脚本：`scripts/uat/m18-discord-visual-samples.ts`
- 首次尝试发现 `.env` 派单频道仍是占位 ID，Discord 返回 `Unknown Channel` 且零消息写入；随后改为只读统一 API Bot 配置取得 `dispatch_channel_id`。
- 成功发送 6 条消息：派单图、真实报名 Embed 与 `1️⃣`、13 张游戏横幅画廊、流单图；所有消息禁用 mentions，业务 API 写入 0。
- 第二次执行返回 `REUSED`，没有重复发送；消息 ID 与配置 request_id 见 `discord-visual-samples.json`。
- 该结果证明真实频道可接收与展示资产，不等于老板/陪玩/客服在桌面和手机上的具名 UAT。

## GREEN

```text
npm run quality:bot
lint/format/typecheck/build passed
Pieces      24 discovered
Bot tests   57 files / 334 tests passed

npm test
build        passed
Test Files   249 passed (249)
Tests        1245 passed (1245)

npm exec vitest run tests/m18-us-08-release-audit.spec.ts -- --config vitest.config.ts
Test Files   1 passed (1)
Tests        3 passed (3)

npm exec vitest run tests/m18-us-03-onboarding-order-experience.spec.ts tests/m18-us-03-welcome-dm.spec.ts tests/m18-us-05-dispatch-trial-experience.spec.ts tests/m11-us-06-selection-reactions.spec.ts tests/m18-us-08-release-audit.spec.ts -- --config vitest.config.ts
Test Files   5 passed (5)
Tests        30 passed (30)
```

## 主要修改文件

- `apps/api/assets/brand/mascot-character-reference.png`
- `apps/api/assets/brand/README.md`
- `apps/api/assets/onboarding/welcome.webp`
- `apps/api/assets/dispatch/*.png`
- `apps/api/assets/game-banners/*.webp`
- `apps/api/assets/game-banners/README.md`
- `evidence/P0/M18-US-08/original-assets.md`
- `apps/api/src/selection-pools.ts`
- `scripts/uat/m18-discord-visual-samples.ts`
- `tests/m18-us-08-release-audit.spec.ts`
- `tests/m5-us-03-release-gate.spec.ts`
- `outputs/P0开发交付包/06-开发计划/backlog.csv`
- `docs/P0开发交付包/06-开发计划/backlog.csv`
- `outputs/P0开发交付包/07-验收测试/test-fixtures.json`
- `docs/P0开发交付包/07-验收测试/test-fixtures.json`
- `docs/runbooks/P0-UAT与发布检查表.md`
- `evidence/P0/acceptance-matrix.csv`
- `outputs/Codex-P0开发TODO.md`
- `docs/Codex-P0开发TODO.md`

## 剩余门禁

- 按 `human-visual-uat.md` 以老板、陪玩、客服三种真实账号完成桌面/手机检查、Reaction 增删、试音匹配、就绪、礼物、取消、错误和重启恢复。
- 为 AT-EXP-002–005 建立符合外部证据合同的独立目录、主 Markdown、附件 SHA-256 和账本记录，再由产品、运营、客服、技术具名签署。
