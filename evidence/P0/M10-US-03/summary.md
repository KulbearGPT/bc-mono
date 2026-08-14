# M10-US-03 候选自动化证据摘要

本文仅记录已执行的本地候选自动化，不声明真实员工 UAT 或 Story 发布门禁已完成。详细实现和历史命令见同目录 `README.md`。

## 自动化覆盖

- `tests/m10-us-03-api.spec.ts`：陪玩明细、对象范围、单席位改派、订单/席位备注更正、终态与已捕获失败关闭。
- `tests/m10-us-03-postgres.spec.ts`：原子改派、备注只追加事件/审计、`PANEL_SYNC`、并发版本和资金不变式。
- `tests/e2e/dashboard/dashboard-order-mutations.spec.ts`：通过真实浏览器控件执行指定席位改派，以及编辑订单备注、清空席位备注并刷新投影。

覆盖验收 `AT-MULTI-010`、`AT-MULTI-015`。权限保持 L1 已认领/L2+ 同 Guild，不要求进入招募。真实 Dashboard 多陪玩视觉 UAT 仍保留为外部项。
