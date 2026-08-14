Acceptance ID: AT-BOT-REV-002
Status: PASSED
candidateRef: git:a07814637ca31a66b3b65bb69bac5d5945ab2111
executedAt: 2026-08-06T18:59:30.207Z
executor: Codex runtime operator
environment: Discord SANDBOX Guild 1533309755873955880
Redaction Review: CONFIRMED
Redaction Details: Discord、数据库和 API 密钥均未记录；证据只保留健康状态、阶段时间、Guild ID 与非敏感汇总计数。

## Preconditions

本地统一 API 与 PostgreSQL health 返回 200，候选 Bot 使用真实 Discord sandbox token 登录，并以独立 3101 端口暴露生产形态的进程 health。

## Steps

先启动 50ms 周期的 health 观察器，再启动候选 Bot；持续记录端点从不可达、关键初始化中的 503 到完成后的 200，并核对启动日志中的配置、常驻入口与有界后台同步结果。

## Expected Result

Bot 在 API health、Guild 配置和 onboarding 恢复完成前保持 503；关键任务成功后转为 200；Role 与产品角色 reconciliation 在后台有界执行且不产生空配置可服务窗口。

## Actual Result

观察器依次记录 UNREACHABLE、503 starting 和 200 ok；配置加载 1 成功 0 失败，onboarding 复用既有消息，Role 同步观察 5 名成员、同步 4 名、失败 0，后台任务完成 1、失败 0。

## Diagnostics

command-output path: evidence/P0/external/AT-BOT-REV-002/readiness-restart-uat.json；健康转换时间分别为 18:59:28.281Z 与 18:59:30.207Z。
