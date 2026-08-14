# M16-US-04 共享 DTO 与工程质量门禁

## 结果

- `AT-REV-006`：钱包余额、流水分页和标准错误 envelope 类型进入 `@blackcat/platform/api-contracts`，API 与 Dashboard 复用同一合同，Dashboard 在运行时验证不可信响应。
- `quality:routes` 以 TypeScript AST 提取生产 server 实际注册的安全路由，并与 OpenAPI method/path 对照；156 个 production operations 均已记录。未由生产 server 调用的开发期 `dispatch.ts` 和 `/__m0` 测试探针不计入生产合同。
- `lint:api-dashboard` 覆盖 API/Dashboard，Dashboard 双重断言、不可达代码和语法/推荐规则违反为 error；现有 39 个 warning 锁为基线，新增 warning 会使门禁失败。
- `format:check` 对共享合同、质量脚本、lint 配置与门禁测试执行 Prettier 检查。

## RED

```text
npx vitest run tests/m16-us-04-quality-gates.spec.ts
Test Files  1 failed (1)
Tests       no tests
Error       Cannot find package @blackcat/platform/api-contracts
```

## GREEN 与回归

```text
npx vitest run tests/m16-us-04-quality-gates.spec.ts
Test Files  1 passed (1)
Tests       2 passed (2)

npm run quality:routes
Route contract parity passed: 156 production operations are documented.

npm run lint:api-dashboard
0 errors, 39 baseline warnings; exit 0

npm run format:check
All matched files use Prettier code style.

npm run typecheck
exit 0

npm run build -w @blackcat/dashboard
1598 modules transformed; built in 369ms; exit 0
```

```text
npm test
Test Files  220 passed (220)
Tests       1066 passed (1066)
Duration    48.46s
```

两份 OpenAPI 均由 Ruby Psych 成功解析；OpenAPI、backlog 与 TODO 的 `outputs/` / `docs/` 镜像逐字节一致，`git diff --check` 通过。

## 修改文件

- `modules/platform/src/api-contracts.ts` 与 platform export
- `apps/api/src/wallet.ts`
- `apps/dashboard/src/customer-wallet.ts`
- `apps/dashboard/src/operations.ts`
- `apps/dashboard/src/OperationsPage.tsx`
- `scripts/check-api-route-contracts.mjs`
- `eslint.config.js`、`.prettierrc.json`、`.prettierignore` 和根 package scripts/lockfile
- OpenAPI `outputs/` / `docs/` 镜像
- `tests/m16-us-04-quality-gates.spec.ts`

## 剩余风险

历史 API/Dashboard 仍有 39 个 lint warning，主要是重复 import 与未使用符号；本 Story 按合同不机械重写全部历史大模块。warning 总数已作为不可增长基线，后续清理应逐步下调 `--max-warnings`。
