Acceptance ID: AT-BOT-REV-001
Status: PASSED
candidateRef: git:a07814637ca31a66b3b65bb69bac5d5945ab2111
executedAt: 2026-08-06T19:02:59.728Z
executor: Codex runtime operator
environment: Discord SANDBOX Guild 1533309755873955880
Redaction Review: CONFIRMED
Redaction Details: Discord Bot token、API service token 与客户身份均未写入证据；客户 ID 已替换为非识别标记，临时频道已删除。

## Preconditions

候选 Bot 已由 main 的 gitignored sandbox 环境启动；Guild 配置版本 17 提供私密订单分类、玩家角色与两个有效客服角色。

## Steps

使用候选代码的 private-order-channel 适配器创建临时频道，读取 Discord 返回的 permission overwrites 与 pins，完成面板编辑和频道命名；删除首个频道后再次创建恢复频道，并在 finally 中清理全部资源。

## Expected Result

公共角色不可查看，客户可查看和发言但不可管理，Bot 与全部已配置客服角色可管理，玩家角色不可查看；订单面板真实置顶，删除后可恢复，失败或测试结束不残留临时频道且不调用订单或资金 API。

## Actual Result

首建与恢复两轮均观测到所有权限断言为 true、面板位于 Discord pins 列表、最终频道名正确；业务 API mutation 调用数为 0，测试后 Guild 中不存在 m17-uat 临时频道。

## Diagnostics

request_id: req_1df9256e-e9de-43f0-818e-64cc41e0c182；command-output path: evidence/P0/external/AT-BOT-REV-001/discord-channel-uat.json
