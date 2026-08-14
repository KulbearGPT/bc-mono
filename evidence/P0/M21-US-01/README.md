# M21-US-01 完单评价合同证据

日期：2026-08-13  
分支：`codex/order-review`  
Story：`M21-US-01`  
验收：`AT-REVIEW-001`、`AT-REVIEW-002`、`AT-REVIEW-003`、`AT-REVIEW-004`

## 完成范围

- 主规格冻结订单整体、完成时有效陪玩、实际客服三类可选评价对象，以及 24 小时评价窗口。
- 冻结低点击 Discord 交互：整体评价最快一次点击；多目标可批量同分或分别打分；星级成功即保存；留言始终可选。
- 冻结明确同意的五星公开流程：保存五星本身不公开；混合评价只发布五星对象的一张安全聚合快照。
- OpenAPI 发布四个计划 operationId，Prisma 发布目标化追加事实、可选留言与公开快照模型；本 Story 不实现运行时或迁移。
- 新增独立 `review_broadcast_channel_id` 与 `five_star_review_broadcast` 配置合同；未修改礼物合同或运行时。

## TDD 证据

### RED

命令：

```text
npx vitest run tests/m21-us-01-review-contract.spec.ts
```

初始结果：`1 file / 5 tests failed`。缺失项包括 M21 backlog、主规格边界、四个 API operationId、三类数据模型、Discord 交互与验收 ID。

### GREEN

命令：

```text
npx vitest run tests/m21-us-01-review-contract.spec.ts tests/m6-us-00-contract.spec.ts
```

结果：`2 files / 12 tests passed`。

覆盖：M21 专项、OpenAPI operationId 唯一与本地引用、合同镜像、backlog/acceptance CSV 列宽和 ID 唯一。

## 结构验证

```text
DATABASE_URL='postgresql://user:pass@localhost:5432/order_review_contract' \
  npx prisma validate --schema outputs/P0开发交付包/03-数据模型/schema.prisma
```

结果：`The schema ... is valid`。

```text
node -e "使用 js-yaml 解析 OpenAPI 与业务配置示例，并用 JSON.parse 解析配置 Schema"
```

结果：`OpenAPI/YAML/JSON parse OK`。

```text
git diff --check
```

结果：通过，无空白错误。

## 已知基线问题

- `tests/m7-us-01-contract.spec.ts` 的 fixture 解析门禁在 M21 fixture 引用改为现有稳定 fixture 后通过；该文件剩余唯一失败是本分支基线已存在的 `docs/outputs Codex-P0开发TODO.md` 一行镜像漂移，不由 M21 引入。M21 新增 TODO 章节已由专项测试单独证明镜像一致。
- 完整业务配置示例在 `HEAD` 与本 Story 后均因既有 `L1_SUPPORT` 权限 Schema 规则失败：`data/access_control/levels/L1_SUPPORT/permissions must NOT be valid`。本 Story 新增的频道、通知和 permission code 均能被 JSON/YAML 解析，未掩盖或扩大该既有问题。

## 完成声明

`M21-US-01` 只完成合同、交互设计、计划与验收门禁。`M21-US-02`–`05` 仍为未完成；不得把 OpenAPI、Prisma 模型或本证据描述为运行时评价功能已上线。
