# M15-US-08 验收证据

## Story

- Story：`M15-US-08` 员工账号完整管理
- 验收：`AT-DOP-007`、`AT-DOP-008`
- 状态：本地自动化完成

## 实现

- `GET /api/v1/admin/staff` 仅对同 Guild、L4、近期 step-up 的 Dashboard 会话开放，返回稳定分页的有效级别、待提权、权限版本和活跃会话数。
- 权限页接入既有提权确认、角色修正/降级、撤销权限和撤销会话 API。
- 首次 L3/L4 提权必须由不同所有者确认；客户端不能直接声明授权级别。
- 每次权限变更使用 expectedPermissionsVersion，并撤销旧会话；唯一有效所有者不能被降级或撤销。

## RED

实现前 Dashboard model 1 file / 2 tests failed：三个员工账号写请求均无构造实现。

## GREEN

```text
Access API/DB/Dashboard Vitest: 3 files / 17 tests passed
API typecheck: passed
Dashboard typecheck: passed
Dashboard production build: passed
Dashboard E2E coverage: 129 planned = 129 implemented
Chromium role mappings + staff accounts: 4/4 passed in 9.9s
```

`DE2E-STF-001`：不同 L4 确认客服 L2→L3，权限版本 4→5、活跃会话 2→0；随后修正回 L2，版本 5→6。`DE2E-STF-002` 验证唯一所有者撤权被 409 拒绝。

## 剩余边界

Discord Role 仍只是观测信号。真实双员工 UAT 与生产 Guild 对账尚未执行。
