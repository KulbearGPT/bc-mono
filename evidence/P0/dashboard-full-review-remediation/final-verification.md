# Dashboard 全量审查整改结论

## 结论

Dashboard-only 修复候选已完成，分支为 `codex/dashboard-full-review-fixes`，基线为 `f32f6e651636b62576096c4523e6f3d873a2d269`。本次未修改 API 或 Bot 运行时代码，所有 Dashboard 写操作仍通过统一 API。

## 已修复问题

| 优先级 | 问题 | 结果 |
| --- | --- | --- |
| P1 | 客服任务切换时可能把新任务与旧订单上下文组合 | 任务与订单改为原子选择并校验 `task.orderId` |
| P1 | 详情乱序响应覆盖当前对象；投影缺字段可触发白屏 | 独立 latest-request gate、运行时归一化和页面错误边界 |
| P1 | 钱包操作只按页面能力显示，未按充值/渠道退款/冲正分别授权 | 三种能力独立裁剪；无权表单不渲染 |
| P1 | 多个追加型写重试会生成新幂等键 | 请求指纹在成功前稳定复用同一键 |
| P1 | APPROVED/EXPORTED 结算批次的合法作废路径无法从 UI 完成 | 强制确认并原子提交替代批次参数 |
| P1 | 未授权/未知直达 URL 回落到功能未开放或首页 | 显式 403、Pilot unavailable 和 404 |
| P1 | 参考数据、标签、MFA、Bot 配置断网时可能无限 loading 或未处理 Promise | 全部收敛为可见错误并恢复控件；分成数据失败不打开写面板 |
| P2 | L1/L2 看不到应有工作流，只看到动作消失 | 合法但无权动作以 disabled 呈现，显示确切权限和 StaffTask 升级路径 |
| P2 | 员工、结算和周报列表无法消费下一游标 | 补齐游标分页和失败恢复 |
| P2 | `ACCEPTED` 仍要求客户 readiness | 改为所有有效陪玩 readiness |
| P2 | 版本化归档在 UI 显示为“删除” | 服务/礼物统一为“归档”并保留历史说明 |
| P2 | 旧 `availability` 被当作主要接单状态 | 从主列表移除，仅在详情保留诊断说明 |
| P2 | M11 已退役的派单超时/最大轮次仍可编辑 | Dashboard 过滤旧 API snapshot 中的退役字段 |
| P2 | 顶栏硬编码 `API ONLINE`、缺少真实检索与账户退出 | 改为“权限已载入”；增加合同支持的订单/用户检索和真实登出 |
| P2 | 错误阈值币种硬编码、旧钱包 E2E 单位错误 | 使用 capability currency 和 CAT subunit 正确预期 |

## 外部阻断与非 Dashboard 合同债务

1. OpenAPI 已声明通用 `/api/v1/admin/approval-requests`，但 API 运行时未注册对应路由。Dashboard 只能诚实显示“审批接口待接入”，不能实现真实待审批计数或通用审批页面。现有 StaffTask 升级链路保持可用。
2. API/Bot 仍保留 `dispatch_timeout_minutes` 与 `dispatch_max_rounds` legacy 字段，与 M11 无时限招募合同存在漂移。Dashboard 已隐藏，彻底删除需要独立 API/Bot 合同 Story。
3. 原 Story 标记为待真实员工或真实 Guild UAT 的项目保持未完成；本地自动化不替代外部签署。

## 最终验证

```text
npx vitest run <51 个 Dashboard 相关文件>
# 51 files / 261 tests passed

npm run typecheck
# passed

npm run build -w @blackcat/dashboard
# passed; JS 458.93 kB, gzip 129.65 kB

npx eslint apps/dashboard/src --max-warnings 0
# passed; zero warnings

npx playwright test --project=chromium --reporter=line
# 143/143 passed

git diff --check
# passed
```

Chromium 第一轮为 137/143；6 项失败均是旧验收仍查找“删除”或要求无权动作完全隐藏。同步到已冻结的“归档”和“可见但禁用”语义后，失败集 20 项中 19 项通过；剩余一项是 PENDING 收益不存在状态不适用的“标记已支付”动作，修正状态断言后单项通过，最终全量 143/143。

## 结构性观察

严格 lint 已从审查基线的警告降为零，并删除了废弃手动派单组件、无引用解析器和无效 props。`AdminBusinessPage.tsx` 与 `styles.css` 仍是较大的发布面；继续物理拆分属于无业务收益的广泛重构，未混入本次 P0 行为修复。后续若继续扩展 Dashboard，建议以页面域拆分为独立维护 Story，并保持本次 261 + 143 门禁不变。
