# M10-US-08 本地 Sandbox 浏览器 UAT

执行日期：2026-08-04
环境：本机 Sandbox；已登录 L4 所有者 Dashboard；不包含任何 Token、Cookie 或数据库连接信息。

## 发现与修复

1. API `/health`、`/ready` 与 Dashboard 首页均返回 200，Discord Bot 身份、目标 Guild 和频道列表只读请求均返回 200。
2. 首次打开 `/admin/service-packages` 时页面返回 `request_id: req_b8d336c9-950b-44eb-9797-ea579f69ad7a`。只读数据库检查确认本地库仅有 18 个已完成迁移，缺少 `service_packages`、`service_package_versions`、`service_package_slots`。
3. 执行仓库标准命令 `npx dotenv -e .env -- npm run db:migrate:deploy`，成功应用 `000019` 至 `000026` 共八个迁移；Prisma 报告 26 个迁移全部完成。
4. 刷新同一已登录页面后，套餐列表正常显示空状态，不再出现请求错误。

## 实际页面检查

- 左侧导航存在“服务套餐”，页面标题、L4 权限和 Sandbox 环境标识正确。
- “创建套餐版本”以 overlay Dialog 打开，不会把详情追加到页面底部。
- 表单包含稳定代码、展示名称、套餐说明、可选套餐总价、立即发布、按顺序的独立陪玩席位、服务项目、计费单位数、默认偏好和原因码。
- 默认说明和占位文案明确支持“两只技术猫猫护航，也可以把其中一席换成聊天陪伴”。
- 每个席位明确生成独立需求，可添加或移除，并能分别选择服务项目。
- 本次只读 UAT 打开并关闭 Dialog，未提交创建，避免在不可变套餐历史中留下未经用户确认的永久测试版本。

## 写入型 UAT（用户于 2026-08-04 明确授权）

- 通过 L4 Dashboard 创建 `UAT_ESCORT_20260804` v1，展示名为“UAT 双猫护航套餐”，勾选立即发布。
- 套餐包含两个有序且独立的 `LOLNA · RANKED` 席位；两个席位分别保存默认偏好，其中第二席明确允许改为聊天陪伴。套餐价格留空，由 API 汇总目录价。
- 首次输入席位偏好时浏览器捕获到 `ServicePackageFields` 读取已释放 React change event 的 `currentTarget.value`，页面变为空白。新增失败回归后，将三个席位输入处理器改为在状态更新前捕获 primitive value；聚焦测试 5/5、Dashboard typecheck 与 diff check 通过，提交为 `cd5c6d7f`。
- 修复后，同一真实表单成功保存两个席位；数据库只读核验返回 `UAT_ESCORT_20260804|1|ACTIVE|2`。
- Discord 外部门禁未能开始业务写入后，通过 Dashboard 使用原因码 `UAT_CLEANUP` 将版本退役。页面显示 `RETIRED`，历史版本和两个席位按合同保留；本次未创建订单、资金预留或礼物请求。

## Discord 外部阻断

- 本机 API 重新以仓库 `.env` 启动并报告 `api.started`；Bot 重新启动后报告 Sapphire ready、目标 Guild 1、Role 同步 4/4、配置加载 1/1，Bot 与 API 均保持 TCP 连接。
- Discord REST 确认当前 Token 对应 Dashboard OAuth 的同一 Application，目标 Guild 内已注册 `service-center`、`bot-config`、`player-workbench`。
- 在“黑猫机器人测试”Guild 的“杂七杂八”频道，从独立浏览器标签页三次调用 `/service-center`，客户端均生成 “Sending command...” 占位，但 Bot Gateway 日志没有收到 interaction。
- 同期 Discord Web 控制台记录频道 ACK 重试、限流延长及 `POST /channels/xxx/messages/xxx/ack [503]`。因此阻断点位于 Discord 客户端/服务端投递层，不是套餐 API 或 Bot handler；没有伪造真实 Guild 通过结论。

## 尚未完成的外部门禁

- Discord Guild 由客户选择套餐、把单个技术席位改为娱乐陪玩、提交订单并在 Bot 重启后恢复。
- 九陪玩跨页送礼及逐条审批、捕获、播报。
