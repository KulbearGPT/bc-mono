# M11-US-01 候选池派单合同与 RED 基线证据

状态：合同 Story 完成。这里只冻结产品、API、目标数据模型、交互与验收合同；运行时迁移、API、Bot、Worker 和真实 Discord/Dashboard UAT 分别属于 M11-US-02 至 M11-US-04，尚未据此声明完成。

## 冻结结论

- 客户为每轮候选池选择 1–30 分钟整分钟等待时间，并可在截止前提前结束。
- ACTIVE、同 Guild 且需求标签匹配的陪玩可报名多个订单；Discord Presence、旧 ONLINE/AVAILABLE/BUSY、其他报名和现有活动订单不阻止报名。
- 报名和进入选秀语音房都不创建 `OrderParticipant`、不占活动订单槽位，也不创建第二笔资金预留。
- 报名窗口结束后进入不限时选秀；系统在客服频道通知订单、候选数和语音链接，不自动选人、不自动扣款。
- 选秀语音 `user_limit=0`；客户、全部有效报名者和配置的客服 Role 可进入。终选后撤销未入选者权限并移出语音。
- 客户一次原子确认一个或多个正式陪玩；最终选择时才锁定并复核活动订单槽、需求容量、审批和标签，任一失效整批零写入。
- 零报名由客户选择继续等待或取消；部分席位已选人员保留，只为缺失席位创建后续候选池。
- 未入选者只获得本人结果与允许公开的入选昵称，不公开评分、排名或内部原因。

## RED

命令：

```text
npx vitest run tests/m11-us-01-selection-pool-contract.spec.ts
```

结果：1 个测试文件、2 个测试中 1 个失败。旧合同缺少 M11 主规格、六个候选池 operation、目标模型和 `AT-SEL-001` 至 `AT-SEL-006`，证明基线会阻止把旧抢单实现误认为新需求。

## GREEN 与回归

- `npx vitest run tests/m11-us-01-selection-pool-contract.spec.ts`：1 file passed，2 tests passed。
- `npx vitest run tests/m9-us-01-contract.spec.ts tests/m10-us-01-contract.spec.ts tests/m10-us-08-service-packages-contract.spec.ts tests/m10-us-08-service-packages-admin-contract.spec.ts tests/m10-us-09-game-scoped-ordering-contract.spec.ts tests/m11-us-01-selection-pool-contract.spec.ts`：6 files passed，12 tests passed。
- `npx prisma validate --schema outputs/P0开发交付包/03-数据模型/schema.prisma`：目标 Prisma schema valid。
- OpenAPI YAML 可解析，527 个唯一内部 `$ref` 均可解析；旧 `acceptOrder` 与 `setMyPlayerAvailability` operation 已从目标合同移除。
- 三个 CSV 分别通过固定列宽检查：交互映射 126 行 / 14 列，backlog 103 行 / 22 列，验收目录 246 行 / 11 列。
- `node scripts/build-p0-acceptance-matrix.mjs`：写入 246 条验收追踪记录。
- 主规格、TODO、交互映射、OpenAPI、目标 Prisma、backlog 与验收目录的 `outputs/` / `docs/` 七组镜像逐字节一致。

## 剩余范围

- M11-US-02：真实数据库迁移和六个统一 API operation，包括并发终选、部分席位与跨池失效。
- M11-US-03：Discord 报名/选秀组件、无限人数语音房、客服通知与落选权限收敛。
- M11-US-04：全量回归、空库迁移、恢复演练及真实 Guild/Dashboard UAT。
