# M9-US-03 玩家注册与陪玩申请 API 证据

`apps/api/src/onboarding.ts` 通过可信 Discord Actor Context 幂等建立 User、DiscordAccount、CAT WalletAccount、待审陪玩档案及可重试角色任务。

`tests/m9-us-03-onboarding.spec.ts` 覆盖注册、重放、申请与可信上下文边界。

2026-08-02 修复已有 Discord 员工首次成为玩家时被拆成第二个 User 的问题：PostgreSQL 注册现在复用 DiscordAccount 已绑定的 User，并在缺少钱包时只创建 WalletAccount。`000012_onboarding_identity_repair` 将已拆分的钱包、充值流水、陪玩档案和产品角色任务合并回 Discord 用户；遇到双钱包、双陪玩档案或不可安全改写的操作者事实时失败关闭。回归覆盖 `AT-ONB-001`、`AT-ONB-002`、`AT-ONB-006`，并保留既有 100 猫条测试余额。
