# M2-US-11 Evidence: 客服暂停、接管与恢复自动化

## Scope

- Story：M2-US-11 客服暂停、接管与恢复自动化
- 验收用例：AT-SUP-002、AT-SUP-005，并回归 AT-SUP-006
- 前置依赖：M2-US-05、M2-US-06

## Implemented

- 订单持久化 `RUNNING / PAUSED`、自动化版本、接管人、关联任务、原因、范围、暂停/恢复时间和到期提示；新订单默认 `RUNNING v1`。
- 实现共享 `pauseOrderAutomation` 与 `resumeOrderAutomation` API。订单版本和自动化版本同时校验，事务内写状态及审计，不改变订单业务状态和预留。
- L1 只能暂停本人已认领的订单任务；L2+ 可暂停并恢复。恢复必须提交与当前状态匹配的 `REDISPATCH`、`RESTART_READINESS_TIMEOUT` 或 `NONE`。
- 派单创建、派单超时、就绪/完成超时、服务生命周期推进和自动取消在执行前读取最新自动化状态；按 `ALL / DISPATCH / LIFECYCLE / CANCELLATION` 范围幂等跳过。
- 暂停中的取消预览强制转客服，订单和预留保持原状；不允许借暂停/恢复绕过退款、结案或转派权限。
- 实现 L2 `resolveStaffTask`，结案只追加任务处理结果，不修改订单或资金事实。
- Discord 订单和个人中心显示“客服处理中”，隐藏推进自动化的控件；Dashboard view model 按等级、任务认领和订单状态启用暂停/恢复，并复用相同 operationId。
- OpenAPI、API 使用说明、权限种子、交互映射及三份 Prisma schema 已统一到上述权限边界。

## Verification

- RED：pause/resume 和 resolve 路由不存在；数据库无 `automation_*` 字段；暂停后 Worker 仍创建派单和超时任务；Bot 仍显示正在匹配；scope 被误当作全局暂停。
- GREEN：M2-US-11 及关联回归 `9 files / 45 tests` passed。
- `npm test`：54 files / 277 tests passed。
- `npm run typecheck`：exit 0。
- `npm run db:validate`：schema valid。
- `npm run db:verify:migration`：migration apply、约束与触发器验证通过。
- `git diff --check`：exit 0。

## Residual Risk

- 真实 Discord Guild 的客服接管消息更新和 Dashboard 浏览器 E2E 尚需凭据及运行环境。
- `expiresAt` 在第一版用于界面提示和运营跟进；自动升级超时任务可在后续独立 Story 增加，不会自动恢复流程。
- 恢复接口返回明确 `resumeAction` 并解除闸门；实际派单或就绪 Job 仍由对应既有操作触发，避免恢复请求隐式重放旧资金意图。
