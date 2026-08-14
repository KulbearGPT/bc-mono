# M10-US-04 本地候选证据

状态：本地候选，尚未完成外部 Discord/Guild UAT，因此 Story 保持未勾选。

已验证：

- 订单参与明细改价在同一事务中派生订单总价，并按差额增加或减少有效资金预留。
- 可用余额不足时，参与明细、订单金额、预留和事件均零写入。
- 多陪玩订单不接受客户代替确认就绪；所有有效陪玩分别确认后才进入服务中。
- 完成订单时，按照每条参与明细的陪玩、项目计费数量和分成快照分别生成收益事实。
- 服务中新增的有效陪玩保持订单现有状态，但其未就绪时最终捕获整笔回滚、无消费和收益写入。
- 真实 PostgreSQL 九人订单补齐就绪后捕获最新 `900 CAT` 预留，生成九条关联 `order_participant_id` 的收益，总计 `450 CAT`。
- 移除旧的 `player_earnings(order_id)` 单收益唯一索引；保留逐参与明细唯一约束和订单时间索引。
- 捕获完成后，参与明细增删改继续由 API 与数据库防线共同拒绝。

执行命令：

```text
npx vitest run tests/m10-us-04-lifecycle.spec.ts tests/m10-us-04-postgres.spec.ts tests/m10-us-03-postgres.spec.ts tests/m10-us-02-db.spec.ts tests/m2-us-04-api.spec.ts
Test Files 5 passed (5); Tests 23 passed (23)

npm run typecheck
tsc -b tsconfig.build.json (passed)

npm run db:verify:migration
migration-apply-ok; table_count=81
```

Discord 多项目下单交互已经由 M10-US-07 候选实现覆盖。剩余门禁：真实 Discord Guild 的九人全员就绪、Dashboard 捕获结果与收益展示外部 UAT；未取得外部证据前 Story 保持未勾选。
