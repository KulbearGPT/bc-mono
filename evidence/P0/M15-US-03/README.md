# M15-US-03 验收证据

## Story

- Story：`M15-US-03` 订单频道记录只读查看
- 验收：`AT-DOP-002`
- 状态：本地自动化完成

## 实现

- `listAdminOrderTranscript` 仅接受 Dashboard session 与 `order.read`。
- L1 必须拥有本人已认领的关联任务；L2+ 只能读取可信 Actor Guild 内订单。越权采用 not-found 失败关闭。
- API 按观测时间与事件 ID 稳定分页，只返回消息生命周期、展示名、正文快照、回复关系和附件元数据。
- Dashboard 在订单详情新增“订单频道记录（只读）”，展示创建、编辑、删除、回复和附件事实，不提供任何 Discord 写操作。

## 验证

```text
Vitest transcript/API/UI/PostgreSQL: 4 files / 12 tests passed
API typecheck: passed
Dashboard typecheck: passed
Root build: passed
Dashboard E2E coverage: 122 planned = 122 implemented
Chromium DE2E-ORD-019: 1/1 passed
Chromium dashboard-order-volume.spec.ts: 7/7 passed in 23.7s
```

合同 Story 的 RED 已证明读端点与 Dashboard 入口缺失；本运行时 Story 未单独保存实现前的测试输出，这是流程证据缺口，不将其描述为已完成的 RED。功能本身由上述自动化覆盖。

## 剩余边界

这是订单/任务 scope 的客服上下文，不是通用聊天归档、全文搜索或 Discord 回复工具。真实员工 UAT 尚未执行。
