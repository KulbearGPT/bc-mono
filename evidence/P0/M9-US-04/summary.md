# M9-US-04 固定 USD 入金与 CAT 钱包 API 证据

管理员充值固定接受 USD cents 收款证据，并以 `creditedCatSubunits = paidAmountUsdCents` 一次性追加 CAT CREDIT。

`tests/m9-us-04-cat-wallet.spec.ts` 覆盖固定比例、非 USD 拒绝、幂等、权限与账本结果。
