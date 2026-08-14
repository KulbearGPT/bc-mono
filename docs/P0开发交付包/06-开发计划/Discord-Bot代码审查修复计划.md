# Discord Bot 全量代码审查修复计划

## 1. 目标与边界

本计划收敛 2026-08-11 对 `apps/bot` 的全量审查发现。实现范围仅包括 Discord Bot 适配器、Bot 运行时、Bot 测试、合同、验收和证据；不借机修改 API 或 Dashboard 业务实现。Bot 继续只消费统一 API 的可信事实，不复制价格、余额、资格、权限、状态迁移或资金规则。

所有修复遵守以下门禁：

1. 同一时间只处理一个已解锁 Story。
2. 代码 Story 先增加可复现失败测试，再做最小实现。
3. 每个 Story 单独更新 `outputs/Codex-P0开发TODO.md`、证据目录和镜像。
4. 每个 Story 对应一个 Conventional Commit。
5. 自动化通过不替代真实 Guild 三角色、桌面与手机 UAT；外部证据缺失时保持发布 Story 未完成。

## 2. 已冻结的业务决定

- 礼物以 M10 多陪玩补充合同为现行事实：客户只能选择订单内有效陪玩明细 `participantIds`，API 从明细推导真实接收人；Bot 和请求体不得接受任意 `receiverId`，任一明细失效时整批零写入。
- 过期或权限已变化的 Discord 组件只能触发回读和刷新，不得以新版本号自动重放旧写操作。
- 候选分页必须双向、重启可恢复、`custom_id` 不超过 100 字符，并保持跨页已选上下文。
- Discord 频道删除、重命名、消息编辑和 transcript 均属于可恢复副作用，必须由可信业务投影或稳定事件身份驱动。
- 所有含用户文本或 mention 的 Bot 渲染默认静默，只有明确用例可以选择性放开 mention。

## 3. 顺序 Story

| Story | 内容 | 主要验收 | RED 证据 | 完成证据 |
|---|---|---|---|---|
| M20-US-05 | 修复计划、礼物多参与人合同统一、镜像与追踪 | AT-MULTI-005; AT-BOT-REV-005 | 合同计划缺失、旧 `order.playerId` 语义、镜像缺失 | 合同专项、M10/M20 合同回归、镜像一致 |
| M20-US-06 | 修复礼物确认/刷新/返回的收件人组件协议 | AT-MULTI-005; AT-BOT-REV-004 | 使用真实 renderer JSON 执行 handler，确认 create API 未调用 | confirm/refresh/back 行为与路由可达性通过 |
| M20-US-07 | 删除 readiness 冲突后的自动写重放 | AT-ACT-003 | 旧版本 READY 当前发生第二次写入 | 409 后只 getOrder + 原位刷新，写调用保持一次 |
| M20-US-08 | 候选双向分页、短路由和跨页选择恢复 | AT-ACT-004; AT-SEL-004 | 59 字符游标产生 116 字符 ID；无上一页；跨页状态丢失 | 所有 ID ≤100、前后翻页、重启恢复、跨页终选 |
| M20-US-09 | 可信频道清理与订单频道副作用恢复 | AT-BOT-REV-001; AT-CHN-003; AT-TRN-003 | 相似名称频道被删除；重命名失败被吞掉 | 精确频道投影校验、负例、可追踪重试/错误 |
| M20-US-10 | Slash Command、Modal 与 acknowledgement 收敛 | AT-BOT-REV-003; AT-BOT-REV-004 | 公共命令无权限；慢 API 前未 ACK；备注异常悬空 | Guild/权限边界、先 defer、所有失败有 request_id |
| M20-US-11 | 全局静默 mention、按钮层级和现行文案 | AT-SEL-007; AT-ACT-002 | renderer 缺 allowedMentions；双 Primary；旧截止文案 | 默认 parse 为空、单 Primary、现行招募/CAT 文案 |
| M20-US-12 | Partial transcript 与 Reaction 稳定幂等 | AT-DOP-002; AT-SEL-008 | 多次 partial edit 共用 unknown；Reaction 使用随机键 | partial fetch/稳定事件 ID、重投与重启收敛 |
| M20-US-13 | 运行时依赖、DTO 校验、会话生命周期与模块债务收口 | AT-BOT-REV-002; AT-BOT-REV-003; AT-BOT-REV-004; AT-BOT-REV-005 | 注入 fetch 未覆盖所有 client；非法 data 穿透；Map 无界；旧 DTO/死计划 | 统一 client 注入、关键 DTO fail-closed、TTL/上限、删除退役语义、全量门禁 |

## 4. 每个 Story 的实现边界

### M20-US-06 礼物

- 统一 renderer 与 handler 的 selected-recipient custom ID 常量和解析器。
- 使用 renderer 产出的 Discord JSON，而不是手工伪造组件结构。
- 覆盖 1、25、26 和多页收件人；确认前不得调用写 API。
- 错误必须准确说明零写入，不再把本地解析失败标为写入不确定。

### M20-US-07 过期动作

- 首次 `setOrderReadiness` 收到 `CONFLICT` 后只读取最新订单。
- 渲染最新 `availableActions` 和 request_id，要求新的显式点击。
- 不为旧 interaction 派生第二个幂等键。
- 保留 API 对权限和版本的最终裁决。

### M20-US-08 候选分页

- Discord custom ID 只携带紧凑 UUID、版本和页码，不携带 API 原始 cursor。
- Bot 从第一页沿服务端 cursor 解析目标页；候选池关闭后投影应稳定。
- 页面同时显示上一页和下一页；返回确认页时从 Discord 消息组件恢复已选 IDs，不依赖进程 Map。
- 分页、修改名单和最终确认均保留刷新、客服与取消入口。

### M20-US-09 Discord 副作用

- 删除语音频道前匹配 API/Worker 提供的精确 retired channel projection、Guild 和用途。
- 名称只能作为显示信息，不能单独授权删除。
- 订单频道重命名失败要记录 request_id/频道 ID，并进入可幂等重试的恢复结果。
- 所有相似名称、错误分类、有人频道和跨 Guild 负例必须保持零删除。

### M20-US-10 交互可靠性

- `/service-center` 不再允许普通成员生成公共常驻面板；部署/修复命令 Guild-only 且受 ManageGuild/服务端权限约束。
- 所有可能访问网络的命令和 Modal 先 defer。
- requirement note、player workbench 和相邻 handler 共用统一错误回复。
- handler 不在 Piece 内重复创建无法注入的基础设施依赖。

### M20-US-11 隐私和可理解性

- `toDiscordReply` 与 `toDiscordUpdate` 默认 `allowedMentions: { parse: [] }`。
- 用户文本、展示名、备注和报名 mention 都不可产生通知。
- 清理“截止前撤回”、USD 内部错误文案和同屏多 Primary。
- 只改展示语义，不改变 API 状态或金额。

### M20-US-12 事件事实

- Message partial 在可读取时先 fetch；删除/不可读取时保持明确缺失语义。
- 每次真实编辑使用不同且稳定的 event ID；相同 Gateway 重投继续幂等。
- Reaction add/remove 和启动对账使用由 Guild、消息、emoji、用户、目标状态及稳定观察身份派生的键。
- 不使用随机幂等键掩盖重复投递。

### M20-US-13 结构收口

- 启动入口构造所有 client 并注入统一 transport/fetch，移除读取环境的模块级业务 client。
- 对订单、钱包、礼物、候选池和配置等高风险 data 执行运行时校验。
- Bot 配置 session 与分页历史增加 TTL、容量上限和清理。
- 删除退役 availability/倒计时 DTO、无生产调用的权限计划与重复 handler 代码。
- 将超大 facade 按 feature action/client 边界拆分；不机械移动、不改变业务行为。

## 5. 验证矩阵

每个 Story 至少运行目标测试和相关 Bot 回归。最终 M20-US-13 运行：

```text
npm run quality:bot
npm test
git diff --check
```

最终审计逐项检查：

- 计划中的九个 Story 均有独立 commit、TODO 状态、修改文件和证据。
- 三个已复现阻断路径均有先失败后通过的 handler 级测试。
- 频道、mention、transcript、Reaction 和运行时错误路径具有负例。
- `apps/bot` 不直连数据库、不计算金额、不自行授权。
- 原有 M18-US-08、M19-US-05、M20-US-04 的真实 Guild 外部 UAT 仍按真实状态报告，不由本计划伪造完成。
