# M17-US-09：Bot 回归、真实 Guild UAT 与发布审计

## 审计结论

状态：`IN_PROGRESS / PENDING_EXTERNAL`。

M17-US-01 至 M17-US-08 的实现与自动化测试已完成。经用户授权，候选从 main 工作区复用 gitignored `.env`，并在真实 Discord SANDBOX Guild 执行频道与重启 UAT；`AT-BOT-REV-001/002` 均已登记为 `PASSED`。M17-US-09 仍保持未完成，因为失效组件与多候选流程需要真实用户操作，且候选尚无 owner/staff 两类具名签署；这些外部事实不能由自动化或 Codex 代签。

真实启动同时发现并修复了一个 M17-US-05 回归：启动配置读取误带只有 Guild、没有 Discord 用户的部分交互头，API 因 Actor Context 不完整返回 `401 AUTH_REQUIRED`。新增测试先复现失败，再让启动读取恢复为纯服务身份；真实 Bot 随后完成配置、onboarding 与后台 Role reconciliation。

后续真实交互以 `request_id: req_59bea027-ed29-4fd5-906d-af6e723aa35b` 发现 Bot 将“只有订单客户可管理候选池”的 `403 PERMISSION_DENIED` 折叠为“操作失败，请刷新后重试”，导致工作人员无法判断刷新并不能解决账号归属问题。修复将 Bot 所有用户可见异常统一进入 `user-facing-error`：显示具体操作、翻译后的服务端原因、可执行下一步、写入是否明确未生效或暂无法确认，并保留 request ID；权限、过期组件、校验、业务规则、余额、限流、认证、超时、断网及无效响应分别处理，未知异常保留受限长度的真实原因。候选池、派单、订单选择、Profile、周报、礼物、客服评价、onboarding 与 Bot 配置入口均已迁移，静态回归禁止重新引入“操作失败/刷新重试”兜底。

## 本地自动化门禁

以下命令已用于本地候选收口：

```text
npm run quality:bot
npm test
npm run db:validate
npm run quality:routes
npm run lint:api-dashboard
npm run format:check
node scripts/build-p0-acceptance-matrix.mjs
node scripts/p0-release-gate.mjs
```

结果：

- `npm run quality:bot`：0-warning ESLint、Prettier、Bot typecheck、根 build、18 个 Piece、47 files / 237 tests 通过。
- `npm test` / 最终 JSON reporter 复验：229 files / 1096 tests 全部通过。真实 UAT 修复后的第一次全仓复验仅因 TODO 发布镜像未同步而失败；同步 `outputs/` 与 `docs/` 后，相关 8 files / 31 tests 与全仓均复验全绿。
- `npm run db:validate`：Prisma schema valid。
- `npm run quality:routes`：156 个 production operations 与 OpenAPI 合同一致。
- `npm run lint:api-dashboard`：0 error，39 个既有 warning 保持锁定基线；本 Story 未修改 API/Dashboard。
- `npm run format:check`：共享合同/门禁文件格式通过。
- `node scripts/build-p0-acceptance-matrix.mjs`：生成 287 条；登记 M17 两项真实结果后，`AT-BOT-REV-001/002` 为 `PASSED`，`AT-BOT-REV-003/004/005` 为自动化覆盖；全项目仍有 69 条非 M17 外部验收保持 `PENDING_EXTERNAL`。
- `node scripts/p0-release-gate.mjs`：按预期退出 1；缺少显式非 example 的 `P0_SIGNOFF_FILE` 与 `P0_CONFIG_SNAPSHOT_FILE`，候选发布 fail-closed。

## 真实 Guild UAT 结果

- `AT-BOT-REV-001`，`2026-08-06T19:02:59.728Z`：配置版本 17；首建和删除后恢复各创建一个临时频道。Discord 返回的 everyone deny view、客户 view/send allow + manage deny、Bot/两个已配置客服角色 manage allow、玩家 deny view 全部为 true；两块面板均出现在 pins 列表；最终命名正确。测试没有调用订单或资金 mutation API，两个临时频道均已删除。证据：`evidence/P0/external/AT-BOT-REV-001/`。
- `AT-BOT-REV-002`，`2026-08-06T18:59:20.293Z` 至 `18:59:30.207Z`：真实进程重启依次观测 `UNREACHABLE → 503 {status: starting} → 200 {status: ok}`；配置加载 1/0、onboarding 复用既有消息、Role 同步观察 5 名成员并同步 4 名且 0 失败、后台任务 1/0。证据：`evidence/P0/external/AT-BOT-REV-002/`。
- 复验后通过 Discord REST 确认 Guild 中没有名称包含 `m17-uat` 的残留频道。

可重复运行脚本：

```text
npx dotenv -e .env -- env M17_UAT_CONFIRM=DELETE_TEMP_CHANNELS npx tsx scripts/uat/m17-discord-channel-uat.ts
```

脚本必须显式设置确认值，始终在 `finally` 删除临时频道，且不读取或输出密钥。

## 剩余外部门禁

下列 Story 级场景仍需要真实用户或具名人员完成，故 M17-US-09 与 EP-M17 保持 `IN_PROGRESS`：

- 由真实用户点击失效组件，复核 ephemeral 错误和 request ID；DM fail-closed 已有自动化覆盖，但真实用户边界尚未签署。
- 由多个真实候选人完成选秀与权限收敛，复核用户可见流程而非仅 handler 自动化。
- owner 与 staff 分别对候选 `git:a07814637ca31a66b3b65bb69bac5d5945ab2111` 具名签署。
- 全 P0 发布门禁还需要非 example 的配置快照；69 条其他模块的外部验收不属于 M17 技术修复，但会继续阻止全项目发布。

精确前置条件、正常 Bot/API 操作步骤、权限与资金对账、清理方法、证据字段和双人签署栏已冻结在 `evidence/P0/M17-US-09/human-uat-runbook.md`。该手册全部结果与签署保持 `PENDING`，不会因文件存在而冒充人工验收完成。

## 最终复验

- `npm run quality:bot`：47 files / 237 tests，通过；Bot ESLint 0 warning、格式、typecheck、build 与 18 Piece discovery 全部通过。
- `npx vitest run --reporter=json --outputFile=/tmp/m17-vitest-results-continuation.json`：229 files / 1096 tests，通过 1096、失败 0。
- `npm run db:validate`：Prisma schema valid。
- `npm run quality:routes`：156 production operations 合同一致。
- `npm run lint:api-dashboard`：0 error / 39 个锁定既有 warning；M17 未修改 API/Dashboard。
- `npm run format:check`：共享门禁文件格式通过。
- `node scripts/build-p0-acceptance-matrix.mjs`：287 条；M17 为 2 项真实 `PASSED` + 3 项 `COVERED_BY_REGRESSION`。

自动化与 Codex 执行的 sandbox UAT 不替代上述剩余真实用户验收和 owner/staff 签署。

## 精确错误提示跟进复验（2026-08-06）

- RED：`tests/m17-us-10-bot-error-messages.spec.ts` 因 `@blackcat/bot/user-facing-error` 不存在而失败，1 suite / 0 tests。
- GREEN：专项错误语义、旧文案更新及 handler 行为 5 files / 38 tests 通过。
- `npm run quality:bot`：48 files / 250 tests 全部通过；ESLint 0 warning、Prettier、Bot typecheck、根 build与 18 Piece discovery 全部通过。
- 首次完整门禁中 47/48 files 通过，运行时子进程测试因并发资源导致 3 个 10 秒超时；该文件单独复验 14/14 通过，停止开发栈释放资源后完整门禁复验 48/48 files、250/250 tests 通过。
- 首次全仓回归仅检出 TODO 发布镜像未同步和一个并发数据库 hook 超时；同步 `docs/outputs` 后，相关合同与数据库 8 files / 38 tests 通过，最终 `npx vitest run --maxWorkers=1` 为 230 files / 1109 tests 全部通过。
- 本跟进仅改善 Bot 错误呈现与诊断信息，不改变 API 权限、订单状态机、资金语义或幂等规则；`M17-US-09` 仍因外部签署与剩余真实用户场景保持 `IN_PROGRESS`。
