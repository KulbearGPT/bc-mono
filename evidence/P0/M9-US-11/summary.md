# M9-US-11 服务与礼物目录归档删除证据

服务目录与礼物目录的操作列新增“删除”按钮。删除采用已有 `archived_at` 字段实现归档：当前活动版本转为 `RETIRED`，目录实体写入归档时间，客户目录与后台默认列表不再返回该项目。历史版本、订单、礼物请求及其金额快照不修改、不级联删除。

Dashboard 在提交前显示归档影响说明并要求原因码；API 继续通过既有 PATCH 写路由执行权限、CSRF、幂等、乐观版本和审计门禁，不新增 HTTP DELETE 路由。

## 验证

- RED：`tests/m4-us-03-dashboard.spec.ts` 2 failed / 16 passed，缺少归档操作和请求映射。
- GREEN：`tests/m9-us-11-catalog-archive.spec.ts tests/m4-us-03-dashboard.spec.ts tests/m1-us-01-api.spec.ts tests/m1-us-01-db.spec.ts tests/m4-us-03-api.spec.ts tests/m4-us-03-db.spec.ts`，6 files / 56 tests passed。
- 最终 `npm test`：155 files / 777 tests passed。
- `npm run typecheck`、Dashboard production build 与 `npm run db:verify:migration` 通过；合同镜像和 215 条验收矩阵可复现。

AT-ARC-001 与 AT-ARC-002 自动化候选完成后仍需登录 Dashboard 做真实浏览器 UAT，Story 保持未完成。
