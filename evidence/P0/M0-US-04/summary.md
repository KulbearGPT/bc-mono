# M0-US-04 Evidence

Story：第三方资金适配契约与可控 Mock

验收关联：`AT-WHK-001`、`AT-REC-001`、`AT-REC-003`

## 修改文件

- `apps/api/package.json`
- `apps/api/src/payment-adapter.ts`
- `package.json`
- `tests/m0-us-02.spec.ts`
- `tests/m0-us-04.spec.ts`

## RED 证据

命令：

```bash
npx vitest run tests/m0-us-04.spec.ts
```

结果：

```text
FAIL tests/m0-us-04.spec.ts
Error: Cannot find package '@blackcat/api/payment-adapter'
```

## GREEN 证据

命令：

```bash
npx vitest run tests/m0-us-04.spec.ts
```

结果：

```text
Test Files  1 passed (1)
Tests  9 passed (9)
```

命令：

```bash
npm run m0:verify
```

结果：

```text
Test Files  4 passed (4)
Tests  38 passed (38)
```

命令：

```bash
npm run typecheck
```

结果：

```text
tsc -b tsconfig.build.json
exit 0
```

## 行为覆盖

- 实现 `discoverCapabilities` 的 native hold 与 local fallback profile，暴露 create/capture/release/get、idempotent writes、lookup by idempotency key 和 TTL 能力。
- 实现 `resolveUser` 与 `getProviderBalance`，返回 provider balance facts，响应中不出现 `availableMinor` 或 `reservedMinor`。
- 实现 `createHold`、`getHold`、`captureHold`、`releaseHold`，包括 stable idempotency key、same fingerprint replay、changed fingerprint conflict、TTL gate、timeout-after-commit recovery、partial capture/release 和金额守恒。
- native hold capture 会生成可退款的 external transaction mirror/ref；`createRefund` 支持成功 hold capture 与 fallback debit，并阻止超额退款。
- 实现 `createReservationDebit` 与 `getTransaction`，基于 modeled reservation binding/version fixture 校验 fresh/stale version，阻止缺失 binding、stale version、currency mismatch 和 insufficient provider balance。
- 实现 runtime money/date invariant 校验：invalid `expiresAt`、provider/hold/transaction currency mismatch 均返回安全错误。
- 实现 `verifyWebhook` 与 `signMockWebhook`，先验签再 parse，校验 timestamp/replay window，校验 normalized event schema，并按 `eventId` 去重。
- `npm run m0:verify` 已纳入 `tests/m0-us-04.spec.ts`。

## 回归验证

命令：

```bash
npm run db:validate
npm run db:verify:migration
npm audit --audit-level=moderate
```

结果：

```text
Prisma schema valid
migration-apply-ok
found 0 vulnerabilities
```

## 未关闭项

- 当前实现是 M0 合同测试用 in-memory mock adapter，不是生产供应商 SDK。
- 真实 Secret 注入、HTTP facade、provider credential rotation、生产 capability checklist 和数据库 external transaction mirror 持久化将在后续 Story 接入。
- Code review follow-up 通过：Critical none，Important none。
