# M9-US-17 接单后语音房与三方通知

## 合同与实现

- 主规格改为接单成功后必须创建或恢复订单私密语音房，不再沿用“prototype 不强制创建”的旧边界。
- 新增 backlog Story `M9-US-17`、交互 `INT-D-059` 与验收 `AT-DSP-019/020`。
- `ORDER_ACCEPTED_CHANNEL_SYNC` 的订单投影读取 Guild、语音房、私密分类、客服任务频道及 L1-L4 Role 配置。
- Worker 以订单公开编号查找或创建语音频道：默认人数 2；everyone 禁止查看/连接；客户和接单陪玩可查看、连接、说话；已配置客服 Role 可查看、连接、说话、管理频道和移动成员。
- 订单保存 `voice_channel_id`；客户 Ticket 与客服频道使用稳定 nonce 分别只发送一次通知，Worker 重启或 Outbox 重试不重复。

## 验证

- `tests/m5-us-02-worker-adapters.spec.ts` 与 `tests/m5-us-02-worker-runtime.spec.ts`：19/19 通过。
- `npm run typecheck`：通过。
- `npm run build`：通过。
- 真实恢复任务 `88738783-caf1-4b5d-81a1-e69bd8095112` 一次完成。
- 订单 `P-374DF0C3` 保存语音频道 `1533742013172809749`；Discord 实测频道位于私密订单分类、人数上限 2，客户和陪玩拥有进入权限，当前已配置的 L2/L4 Role 拥有管理权限。
- Ticket 实测包含客户 mention 和语音链接；客服任务频道实测包含订单号与同一语音链接。

## 剩余门禁

当前 Guild 只配置 L2 与 L4 Discord Role 映射，尚无 L1/L3 映射；实现会纳入所有已配置的四级 Role，但完整四级真实权限 UAT 必须在 L1/L3 Role 配置完成后执行，因此 Story 保持未勾选。

## 2026-08-04 客服协调 Embed 增强

- 客服任务频道的匹配成功通知由单行文本改为标准 Discord embed。
- 协调前可查看订单公开编号、当前状态、客户、全部 ACTIVE 陪玩，以及每个需求的游戏、服务、区服、时长、需要人数和客户备注。
- 下单时间与匹配时间使用 Discord 本地化时间；卡片同时提供“打开订单频道”与“进入协调语音房”链接按钮。
- 投影同时兼容新的多需求订单和旧的整单快照；不展示金额、余额、支付信息、内部定价或陪玩审核信息。

### RED / GREEN 与回归

- RED：`npx vitest run tests/m5-us-02-worker-adapters.spec.ts` → 2 failed / 10 passed，失败分别覆盖协调投影字段和客服 embed payload。
- GREEN：同一命令 → 1 file / 12 tests passed。
- 关联回归：`npx vitest run tests/m5-us-02-worker-adapters.spec.ts tests/m5-us-02-worker-runtime.spec.ts tests/m5-us-02-worker-db.spec.ts` → 3 files / 22 tests passed。
- 合同镜像：`npx vitest run tests/m7-us-01-contract.spec.ts tests/m8-us-01-contract.spec.ts` → 2 files / 10 tests passed。
- `npm run typecheck` 和 build 通过。
- `npm test` → 182 files / 903 tests passed。

### 剩余风险

- 新卡片尚未在真实 Guild 中复验视觉密度、链接按钮和九项目长备注截断效果；M9-US-17 仍保持未勾选。
