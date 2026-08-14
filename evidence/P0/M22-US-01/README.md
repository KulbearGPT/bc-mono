# M22-US-01 独立送礼与匿名合同证据

## 结果

合同已冻结，运行时尚未实现。订单内送礼保持兼容；独立入口仅接受统一 API 返回的同 Guild ACTIVE `playerProfileId`，服务端派生真实接收人；匿名仅隐藏陪玩与公共播报中的老板身份，内部客服、资金、风控和审计保留真实发送者。

客服辅助的付款授权仍是显式产品决策项：在确认“客服直接预留老板余额”或“老板最终确认”之前，不实现代客扣款路径。

## 验收

- `AT-GIFT2-001`：独立送礼可信接收人。
- `AT-GIFT2-002`：余额不足和并发超支零写入。
- `AT-GIFT2-003`：匿名展示不泄露老板身份，内部仍可追踪。
- `AT-GIFT2-004`：Discord 常驻入口单卡恢复合同。

## 验证先行

- RED：`npx vitest run tests/m22-us-01-standalone-gift-contract.spec.ts`，1 file / 5 tests 全失败。
- GREEN：同命令，1 file / 5 tests 全通过。
- 合同/追踪：专项、Prisma 镜像、业务配置、路由与 traceability 组合为 5 files / 82 tests，全通过。
- Prisma：`npm run db:validate` 通过。
- 路由：`node scripts/check-api-route-contracts.mjs`，183 个运行时 operation 与现行 OpenAPI paths 精确一致；M22 operation 保持顶层 PLANNED 扩展，不伪装为运行时路由。
- 追踪：`node scripts/build-p0-acceptance-matrix.mjs` 生成 317 行；8 个新合成 fixture 均可解析，两个外部 UAT 用例各在发布清单映射一次。
- 全仓：`npm test`，288 files / 1443 tests 全通过；`git diff --check` 通过。

## 范围声明

本 Story 只修正规格和合同，不把 planned API、数据模型或交互描述宣称为可运行功能。运行时迁移和 API 属于 `M22-US-02`，Discord 入口属于 `M22-US-03`，客服辅助属于 `M22-US-04`。
