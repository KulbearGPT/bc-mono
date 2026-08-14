# M10-US-06 真实环境 UAT 只读预检

执行日期：2026-08-04

## 已通过

- 本机 API 与 Dashboard 均可访问；`/health`、`/ready` 返回 200。
- `.env` 中 Discord Bot Token、目标 Guild、API、Dashboard 与数据库配置可用；检查过程未输出任何秘密值。
- Discord REST 只读验证：Bot 身份、Guild、13 个频道与 Bot Guild Member 均返回 200。
- Guild 已注册 `service-center`、`player-workbench`、`bot-config` 三个命令。
- Bot 使用当前 Actor Context 与服务身份调用本机 `/api/v1/service-packages` 返回 200，说明 Bot→API 鉴权链可用。
- Sandbox 当前有 3 个启用服务目录版本、4 个 Discord 绑定账户、2 个已批准陪玩、4 个钱包账户。
- 本地数据库从 18 个迁移补齐到全部 26 个迁移；套餐三张表已建立。

## 写入后状态

- 用户明确授权 Sandbox 写入后，已创建并发布一个双席位 UAT 套餐；数据库核验为版本 1、两个席位。
- 测试结束时已退役该套餐；历史版本按 append-only 合同保留，启用套餐恢复为 0。
- API 与 Bot 均已正常启动，Bot 报告 Sapphire ready、目标 Guild 配置加载和 Role 同步完成。
- Discord Web 三次调用 `/service-center` 均停留在 “Sending command...”，Bot Gateway 未收到 interaction；浏览器同时记录 Discord ACK 503。因此真实套餐下单、重启恢复和多人礼物 UAT 未执行，且本轮没有创建订单或资金事实。

## 剩余外部门禁

待 Discord interaction 投递恢复后，需重新发布一个测试套餐并执行客户选套餐、改单席位、提交、Bot 重启恢复、多人礼物及审批/捕获/播报。所有后续业务事实仍须按合同保留或以取消/退役方式清理。
