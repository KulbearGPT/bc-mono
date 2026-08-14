# M10-US-05 本地候选证据

状态：API、数据库和 Discord 跨页累积选择候选已实现；真实 Guild UAT 尚未完成，因此 Story 保持未勾选。

已验证：

- 创建礼物请求只接受订单陪玩明细 ID，不接受接收人用户 ID；API 去重并从有效 `OrderParticipant` 推导接收人。
- 九位陪玩会在同一 PostgreSQL 事务中创建九条独立 `GiftRequest`、九笔活动预留、九个客服任务和九个过期任务，总预留等于单价乘人数。
- 每条新礼物事实固化 `order_participant_id`；旧礼物可保守回填，无法匹配时保持空值以保留历史。
- 任一陪玩失效、接收人绑定不一致、余额不足、订单/目录版本冲突或审计失败时整批零写入。
- 原有逐条核对、审批、捕获、取消、消费和播报回归保持通过。
- Discord 将已选参与明细压缩进消息组件游标；翻页、Bot 进程重启或由另一实例处理时无需依赖进程内状态，并在最终请求前由 API 再次校验全部参与明细。
- 30 人分页组件测试覆盖第一页和第二页选择状态的往返恢复；确认页按每 25 人一组保留选中身份，供最终提交读取。

执行命令：

```text
npx vitest run <M3/M6 gift regression plus M10-US-05>
Test Files 21 passed (21); Tests 74 passed (74)

npx vitest run tests/*bot*.spec.ts
Test Files 24 passed (24); Tests 118 passed (118)

npx vitest run
Test Files 179 passed (179); Tests 877 passed (877)

npx prisma validate --schema database/prisma/schema.prisma
npx prisma validate --schema outputs/P0开发交付包/03-数据模型/schema.prisma
npm run typecheck
npm run build
all passed

npm run db:verify:migration
migration-apply-ok; table_count=81
```

剩余门禁：九人真实 Guild 跨页组件交互、送礼、逐条审批/捕获/播报外部 UAT。
