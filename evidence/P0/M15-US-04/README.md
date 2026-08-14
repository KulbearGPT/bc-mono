# M15-US-04 验收证据

## Story

- Story：`M15-US-04` Bot 配置完整后台
- 验收：`AT-DOP-003`
- 状态：本地自动化完成

## 实现

- Dashboard 新增 Bot 配置导航和表单，字段清单由 API 按可信员工等级返回，不在浏览器自行推断权限。
- 更新采用“服务端预检 → 短期 validation token → expectedVersion 写入”；成功后刷新 canonical 配置。
- L3 可管理运营参数与执行频道测试投递；L4 才可看到安全 Role 字段。
- Dashboard 实际写入安全 Role 时必须具有近期 step-up；Discord Bot 的既有受信任调用合同不受影响。

## RED 与缺陷

实现前 `npx vitest run tests/m15-us-04-bot-config-dashboard.spec.ts` 因缺少 `bot-config-dashboard.js` 失败。

开发中发现 1 个此前未被运行时测试发现的安全缺陷：合同声明安全 Role 配置要求近期 step-up，但 API 更新路由没有执行该门禁。修复后的门禁只作用于 Dashboard 的实际敏感写入，并保留字段级 403、请求格式 400 与既有 Bot 调用语义。

## 验证

```text
Bot config Vitest regression: 4 files / 24 tests passed
API typecheck: passed
Dashboard typecheck: passed
Dashboard production build: passed
Dashboard E2E coverage: 124 planned = 124 implemented
Chromium DE2E-BOT-001..002: 2/2 passed in 8.1s
```

## 剩余边界

系统不展示或保存 Discord token。测试投递只验证既有频道配置；真实 Discord Guild UAT 尚未执行。
