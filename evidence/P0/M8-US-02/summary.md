# M8-US-02 展示配置与精确格式化证据

日期：2026-07-21

## 验收范围

- `AT-TKN-002`：固定 `1 USD = 10 MB`，1 USD cent 精确显示 `0.10 MB`。
- `AT-TKN-003`：默认“猫币 / MB”，可通过 `WALLET_DISPLAY_NAME` 与 `WALLET_DISPLAY_SYMBOL` 全局替换。
- `AT-TKN-007`：显式空值、超长或非法符号在 Discord 登录及生产校验前失败关闭。

## RED

```text
npx vitest run tests/m8-us-02-wallet-display.spec.ts
# FAIL: Cannot find package '@blackcat/bot/wallet-display'
```

失败原因是展示配置与格式化模块尚不存在，符合测试先行预期。

## 实现

- 新增独立 Bot 展示模块，以 `BigInt(amountMinor) * 10n` 计算代币百分位，再手工分组和补足两位小数；未使用浮点换算。
- 拒绝非 safe integer、非整数金额和任何非固定 `unitsPerUsd: 10` 配置。
- 名称允许 1–20 个 Unicode 字符；符号允许 1–8 个 Unicode 字母、ASCII 数字、`_`、`-` 或 `·`。
- `.env.example` 仅增加名称和符号，没有比例环境变量；Bot 在 Piece discovery 和 Discord 登录前校验。
- 生产环境校验脚本应用同一失败关闭边界；业务配置文档与发布镜像同步。

## GREEN

```text
npx vitest run tests/m8-us-02-wallet-display.spec.ts tests/m0-us-01.spec.ts tests/m5-us-03-release-gate.spec.ts
# 3 files / 32 tests passed

npm run typecheck
# exit 0

npm run build
# exit 0

git diff --check
# exit 0
```

发布门禁的首次聚焦运行发现新外部验收 `AT-TKN-004`、`AT-TKN-005` 未进入 UAT 清单；补齐两个唯一映射并将外部验收基线从 48 更新到 50 后，聚焦门禁全部通过。

本 Story 尚未把格式化器接入客户消息；选择性渲染由 M8-US-03 完成。
