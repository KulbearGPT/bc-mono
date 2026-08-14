# M23-US-01 — NUI-A0 共用非 UI Harness

状态：自动门禁完成，等待独立提交。

本 Story 冻结 `M23-US-01`～`M23-US-09` 顺序依赖，建立 77 个业务场景的显式机器清单，并实现共用隔离 PostgreSQL、确定性 fixture、故障注入、零写入/资金/审计/隐私断言和报告 schema。M22 礼物测试已迁移到相同 Harness，停止失败不再被吞掉。

详细证据见 `summary.md`；机器覆盖清单见 `../non-ui-automation/coverage.json`。
