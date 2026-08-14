# M9-US-05 Discord 常驻入口与角色补偿证据

Bot 会在新人入口频道维护唯一常驻消息，提供“注册为玩家”和“申请成为陪玩”两个中文按钮，所有业务写入均调用 API。

`tests/m9-us-05-onboarding-bot.spec.ts` 覆盖渲染、唯一消息恢复、ephemeral 反馈和角色任务对账。真实 Guild UAT 仍待签署。
