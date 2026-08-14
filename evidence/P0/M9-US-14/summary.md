# M9-US-14 客户优先派单名单

## 行为

- API 与派单层保留最多三名优先陪玩的有序快照、校验和首轮派单语义；M10-US-09 四步点菜式向导为与批准原型一致，已移除旧草稿面板的 User Select，待单独设计入口后再接回。
- 统一订单 API 校验数组最多三项、不可重复且必须为 Discord Snowflake，并把名单写入订单的 `requirement_snapshot`；读取订单后可恢复已选数量，Bot 重启不丢失。
- 第一轮派单先执行原有 ACTIVE、AVAILABLE、ONLINE、游戏/服务标签和无活跃订单校验。若名单内存在合格陪玩，第一轮仅通知这些人；若名单无人合格则立即使用普通合格池。
- 90 秒首轮超时后，`TIMEOUT_RETRY` 使用普通合格池。名单不保证指定、不绕过准入，也不向客户泄露成员不合格的原因。

## 验证

- RED：`tests/m9-us-14-preferred-dispatch.spec.ts` 3/3 失败，缺少优先排序函数、User Select 和订单快照字段。
- GREEN 定向：订单面板、派单、订单 API 与新 Story 共 4 个测试文件 / 29 个测试通过。
- 合同追踪：新增 AT-DSP-013/014，验收矩阵重建为 219 项。
- `npm run typecheck`：通过。
- 最终 `npm test -- --run`：158 个测试文件 / 788 个测试全部通过。
- `npm run db:validate`：Prisma 合同有效；本 Story 复用已有 `requirement_snapshot`，不新增迁移。
- API、Worker 与 Bot 已重新构建并重启；Bot 日志确认 ready、配置 1/1 加载且常驻入口原位恢复。

## 状态

自动化候选已完成；仍需在真实 Discord Guild 验证零至三人多选、错误选择的安全跳过、首轮优先接单和 90 秒普通池回退，因此 Story 保持未勾选。
