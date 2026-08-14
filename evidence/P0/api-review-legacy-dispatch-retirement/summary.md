# 旧自动派单 API 退役证据

## 范围与结论

- Story：`codex/api-review-legacy-dispatch-retirement`
- 验收：`AT-DSP-011;AT-DSP-012;AT-DSP-015;AT-SEL-001;AT-SEL-005;AT-SEL-007`
- M11 候选池是现行唯一分配流程：客户手动开始和终止无时限招募，陪玩报名不占正式席位，客户最终原子选择一名或多名陪玩。
- 审查发现旧 first-wins 路由虽未注册，但生产 API 仍初始化旧 Dispatch store，并允许读取和写入 `dispatch_timeout_minutes`、`dispatch_max_rounds`、`auto_dispatch_enabled` 与 `DISPATCH_TIMEOUT_MINUTES`。这些写入会表现为“成功保存但对当前业务无效”，也增加误接回旧流程的风险。
- 现行 API 已停止装配旧 Dispatch store，不返回、不接受写入也不消费上述退役值；历史数据库 JSON、旧表及 TypeScript 只读兼容类型暂不破坏性删除。
- 未查看或修改 Bot、Dashboard 源码。

## RED

- 新增 `tests/api-review-legacy-dispatch-retirement.spec.ts` 后为 1 file / 4 failed。
- 失败分别证明：Bot 配置 GET 暴露并允许写入退役字段；策略列表与更新仍接受旧超时键；生产入口仍实例化旧 Dispatch store；OpenAPI 与业务配置仍把旧字段当现行合同。

## GREEN

- Bot 配置 GET 仅投影现行字段；L3/L4 `manageableFields`、validate、PATCH 及内存/PostgreSQL store 都拒绝退役字段。历史 JSON 在更新其他字段时仍保留，但不会对外投影。
- Operations 策略列表过滤旧超时键，策略读取返回调用方 fallback，更新失败关闭为 `VALIDATION_ERROR`。
- `index.ts` 与 `ApiServerOptions` 删除旧 Dispatch store、player pool、channel 和组合参数；SelectionPool 路由仍是唯一生产分配 API。
- OpenAPI、API 使用说明、业务配置示例、JSON Schema、seed 与说明镜像统一为手动无时限候选池；报名资格不再依赖 Discord Presence、旧 availability 或已有活动订单，终选由客户原子完成。
- 旧 M2/M4 测试改为验证当前装配边界和仍有效的运营策略，不再把旧超时策略当作现行能力。

## 验证

- RED：1 file / 4 tests 全失败。
- 聚焦 API/配置/PostgreSQL 回归：9 files / 65 tests 与后续核心 6 files / 44 tests 全通过。
- API ESLint 零告警、API typecheck、根 build、179 个生产 operation/OpenAPI 双向一致性全通过。
- 业务配置 JSON Schema 可解析，六组 `outputs/` / `docs/` API/配置镜像逐字节一致。
- 最终全仓：281 files / 1407 tests 全通过，110.67 秒。
- 一次并发全仓尝试曾因另一个工作区同时运行 Vitest 导致 4 个进程型门禁超时；资源恢复后这 4 files / 21 tests 单独全通过，随后完整回归全通过，因此未把环境超时记录为产品缺陷。
- `git diff --check`：通过。

## 剩余兼容边界

- `apps/api/src/dispatch.ts` 仍保存未装配的历史 first-wins 领域/路由代码，供旧行为测试和迁移阅读；生产入口与服务器选项均无法到达，结构测试会阻止重新装配。建议在独立 P2 清理 Story 中先替换历史 characterization tests，再删除该模块的路由层和旧 Outbox 类型。
- Bot 源码不在本次范围内；若其配置交互仍展示退役字段，当前 API 会安全返回 `400 VALIDATION_ERROR`，但该客户端呈现应由 Bot 专项审查单独清理。
