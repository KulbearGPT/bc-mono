# M19-US-02 招募与试音跨角色刷新审计

## 结论

逐写路径审计及 2026-08-10 真实订单回归已补齐本 Story 的运行时投影缺口：

- 开始招募：同事务写入 `SELECTION_POOL_SYNC` 与 `PANEL_SYNC`。
- 普通报名/撤回及 Reaction 报名/撤回：成功事实同事务写入 `PANEL_SYNC`，客户订单面板更新有效报名名单；公开 Reaction 本身展示报名身份。
- 终止招募：写入试音阶段同步与客户面板同步，Worker 幂等关闭报名卡、创建/恢复试音房并发送一次客服通知。
- 部分正式确认：订单保持 `PENDING_DISPATCH`，原位编辑客户与客服试音消息，显示已确认阵容和剩余缺口。
- 全部正式确认：订单进入 `ACCEPTED`，原位编辑客户与客服消息，创建/恢复服务房并由独立 `PANEL_SYNC` 进入就绪阶段。
- 重试与重启：稳定 nonce、持久化 message/Reaction 映射和 Outbox dedupe 防止重复业务事实或重复卡片。
- 备注一致性：派单项目优先展示项目级备注；项目备注为空时回退到整单老板备注。客户常驻订单面板使用同一优先级，避免“老板已留言”与“暂未留言”并存。
- 客户订单卡：Worker 常驻面板不再直出 `PENDING_DISPATCH`、`IN_SERVICE` 等技术枚举，统一展示服务内容、订单金额、老板需求、已确认阵容、报名/生命周期进度和下一步，并保留原位刷新及状态允许的唯一主操作。
- 部署收敛：Worker 启动时以 `order-panel-experience-v2:{orderId}` 稳定 dedupe 为所有活动订单补一条 `PANEL_SYNC`，一次性把已有客户面板升级到新 renderer，不重复业务写入。

## 2026-08-10 回归事实

对真实订单 `P-D7413498` 做只读数据库核对：订单为 `PENDING_DISPATCH`，`orders.customer_note` 为“会聊天”，活动项目的 `order_requirements.customer_note` 为 `NULL`。旧派单投影只读取项目备注，因此错误显示“老板暂未留言”；旧客户常驻面板同时绕过 M18 renderer，直出技术状态并把事实堆在单段文本中。

修复文件：

- `apps/api/src/selection-pool-worker.ts`
- `apps/api/src/worker-adapters.ts`
- `apps/api/src/worker.ts`
- `tests/m11-us-06-selection-reactions.spec.ts`
- `tests/m5-us-02-worker-adapters.spec.ts`
- `outputs/Codex-P0开发TODO.md`
- `evidence/P0/M19-US-02/summary.md`

## 验证

```text
npx vitest run tests/m11-us-02-selection-pools-postgres.spec.ts tests/m11-us-03-selection-discord.spec.ts tests/m11-us-06-selection-reactions.spec.ts tests/m18-us-05-dispatch-trial-experience.spec.ts
```

结果：4 files / 40 tests passed。

2026-08-10 回归命令：

```text
npx vitest run tests/m5-us-02-worker-adapters.spec.ts tests/m11-us-03-selection-discord.spec.ts tests/m11-us-06-selection-reactions.spec.ts tests/m18-us-04-order-panel-experience.spec.ts tests/m18-us-05-dispatch-trial-experience.spec.ts
```

结果：5 files / 60 tests passed。

```text
npm run typecheck
```

结果：`tsc -b tsconfig.build.json` 通过。

## 边界

- 招募期尚未存在普通客服协同卡；客服只在进入试音匹配或发生自动化失败时需要被通知，因此每次报名不额外刷客服频道。
- `ACCEPTED` 之后的客服协同卡逐人就绪刷新属于 `M19-US-03`，不在本 Story 冒充完成。
