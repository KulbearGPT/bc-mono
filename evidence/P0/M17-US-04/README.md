# M17-US-04：Bot 工程质量门禁

## 实现结果

- 根工程新增 `lint:bot`、`format:bot`、`format:bot:check`、`test:bot` 和组合门禁 `quality:bot`。
- ESLint 的 TypeScript/Node 规则覆盖 `apps/bot/src/**/*.ts`，并以 `--max-warnings 0` 禁止新增或保留 warning。
- `scripts/run-bot-tests.mjs` 按稳定文件名顺序发现静态引用或检查 Bot 源码的测试，避免依赖临时 shell glob。
- 对 31 个 Bot 源文件执行一次机械 Prettier 基线；只额外删除 4 个未使用变量/导入，并把 2 处不可见全角空白改为显式 `\\u3000`。
- 3 个旧 source 断言由精确空白字符串改为语义等价正则，避免格式化本身造成伪失败。

## RED 与首次规范基线

```text
./node_modules/.bin/vitest run tests/m17-us-04-bot-quality-gates.spec.ts
Test Files  1 failed (1)
Tests       3 failed (3)

npm run lint:bot
2 errors, 4 warnings

npm run format:bot:check
31 files with code style issues
```

## GREEN

```text
npm run quality:bot

eslint apps/bot/src --max-warnings 0
0 errors, 0 warnings

prettier --check apps/bot/src
All matched files use Prettier code style

tsc -p apps/bot/tsconfig.json --noEmit
tsc -b tsconfig.build.json

npm run pieces -w @blackcat/bot
18 pieces discovered

node scripts/run-bot-tests.mjs
Test Files  43 passed (43)
Tests       222 passed (222)
```

## 修改文件

- `package.json`
- `eslint.config.js`
- `scripts/run-bot-tests.mjs`
- `tests/m17-us-04-bot-quality-gates.spec.ts`
- 31 个 `apps/bot/src` Prettier 基线文件。
- 3 个仅调整空白敏感断言的既有测试。
- Backlog、双 TODO 与本证据。

## 剩余门禁

后续 M17 Story 必须持续通过 `npm run quality:bot`；全仓测试和外部 UAT 在 M17-US-09 收口。
