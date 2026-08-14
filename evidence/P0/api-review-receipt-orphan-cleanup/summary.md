# API 全量审查：私有凭证孤儿文件清理

日期：2026-08-13

## 审查结论

充值/线下渠道退款的可选凭证上传此前先把文件写入私有目录，之后才验证 multipart 字段、核对资金依据并提交元数据与成功审计。无效 `evidenceId`、不存在的资金依据或事务/审计提交失败都会返回错误，但已经落盘的文件没有数据库引用，也没有清理路径，形成不可达的敏感孤儿文件。

本候选在不新增文件删除 API、不修改 Bot/Dashboard 源码或公开上传/下载合同的前提下完成以下修复：

- `ReceiptStorage` 增加仅供服务端补偿使用的幂等 `remove(storageKey)`；私有文件实现继续只接受不透明 UUID key，并用精确目标删除，重复清理安全成功。
- 上传 handler 在文件落盘后的解析、字段验证、资金依据核对或 staging 失败时立即删除暂存文件。
- 安全写路由的 staged-write 协议增加可选 `abort` 补偿；审计快照、成功审计或事务 commit 失败时调用补偿，随后仍保留原始业务错误与幂等失败事实。
- PostgreSQL 生产路径只有资金凭证元数据和成功审计同事务提交后才保留文件；已成功提交的凭证不会触发补偿，授权下载行为不变。
- 自动化覆盖文件在 multipart 中先于字段出现的实际顺序，证明无效字段、资金依据不存在和 commit 失败后三种路径目录均为空。

## 验收与风险边界

- 关联验收：`AT-WAL-007`、`AT-AUD-002`。
- 凭证业务事实仍是 append-only；没有提供用户或员工硬删除已提交附件的能力。
- `abort` 删除失败不会覆盖原始业务/提交错误，以免改变幂等结果；本地私有存储删除本身有独立幂等测试。基础设施级权限或磁盘故障仍需运维告警与目录对账发现。

## 变更文件

- `apps/api/src/receipt-storage.ts`
- `apps/api/src/security.ts`
- `apps/api/src/wallet.ts`
- `tests/api-review-receipt-orphan-cleanup.spec.ts`

## 可复核证据

- 未通过基线：新增测试首次运行 1 file / 4 tests 全失败；分别证明存储没有删除能力，且无效字段、业务依据不存在、事务提交失败都会保留一个孤儿文件。
- `npm run typecheck -w @blackcat/api`：通过。
- 凭证、钱包、审计、安全写入聚焦回归：7 files / 39 tests，通过。
- `npm run build`：通过。
- `npx eslint apps/api/src --max-warnings 40`：0 errors；27 个均为既有 warning，本次未增加 warning。
- `git diff --check`：通过。

## 剩余外部风险

文件系统权限失效、只读磁盘或删除时底层 I/O 故障可能使补偿失败；当前实现保留原始请求失败并允许对 UUID key 重试清理，但仓库尚无独立的长期孤儿目录扫描/告警进程。该项作为运维剩余风险保留，不影响本次已覆盖的正常失败路径。
