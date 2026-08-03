/**
 * Long-form, user-facing Bot copy.
 *
 * Short component labels such as “确认” and “取消” stay beside their
 * components. This catalog contains complete messages that are reviewed and
 * rewritten as a unit; it is intentionally not an i18n layer.
 */
export const BOT_COPY = {
  onboarding: {
    welcomeIntroduction: '今晚想找一位合拍的游戏搭子，还是加入我们的陪玩猫舍？ฅ^•ﻌ•^ฅ',
    customerPath: '第一次来请先注册玩家，我们会准备账户和猫条钱包；完成后就能开始下单。',
    companionPath: '先注册玩家，再提交陪玩申请；猫舍前台审核通过后即可参与报名。',
    supportPath: '充值、订单或申请遇到问题时，请在服务中心联系猫舍前台。',
    privateWelcomeIntroduction:
      '新朋友，黑猫已经为你点亮今晚的入口。🌙\n无论想认真上分、轻松娱乐，还是找个人聊聊天，都希望你能在这里遇见合拍的陪伴。',
    privatePlayStyles: '上分冲刺、娱乐开黑、聊天小游戏、唱歌声优……今晚由你定义，我们负责把需求送到合适的人面前。',
    privateCustomerPath: '前往「服务入口」，先注册玩家，再点击「开始找陪玩」提交你的需求。',
    privateCompanionPath: '想成为陪玩时，也可以在服务入口先注册玩家，再提交陪玩申请。',
    privateSupportPath: '充值、订单或申请遇到问题，可从服务入口联系猫舍前台处理。',
    privatePromise: '需求会先确认，订单进度随时可查；遇到问题可以找到真人客服。我们不在私信中索要密码或完整付款信息。',
    privateFirstSteps: '① 打开黑猫服务入口\n② 注册或确认玩家账户\n③ 点击「开始找陪玩」，创建属于你的私密订单',
    invalidEntryChannel: '新人入口暂时无法使用，请联系猫舍前台处理。'
  },
  gifts: {
    staleBalance: '**🐟 猫条余额需要刷新**\n\n当前余额信息已经过期。请先刷新余额，再继续确认礼物。'
  },
  orders: {
    publicEntryIntroduction:
      '今晚想找一位合拍的游戏搭子？从这里提交委托即可。\n\n**下单前请留意**\n每位客人同一时间只能有一个进行中的订单；如果已有订单，我们会带你回到原频道。',
    matchingUnavailable: '**🐾 暂时没有拿到最新匹配进度**\n\n请稍后刷新。你的订单和已预留猫条不会因此重复处理。',
    reviewPaused: '**🛎️ 这笔订单已交由猫舍前台照看**',
    reviewInProgress: '自动派单和超时处理已暂停，客服正在核对具体情况，请等待处理结果。',
    completionPending:
      '**✨ 陪玩已提交完成申请**\n\n**下一步**：等待客人确认。\n如对服务情况有疑问，可以联系猫舍前台处理。',
    staffReviewScope: '客服会核对订单记录、语音频道和双方说明；核对期间不会自动取消、退款或扣罚任何一方。',
    reservationOnly: '目前只是预留本单所需猫条，还没有产生正式消费。',
    dispatchStarted:
      '**🐈‍⬛ 猫舍正在为你寻找合适的陪玩**\n已通过资格审核、属于同一服务器且需求标签匹配的陪玩现在可以报名。服务开始前取消订单，预留猫条会按规则释放。',
    accountUnavailable: '账户还没有准备好，请联系猫舍前台协助开通。',
    cancellationEscalated: '**🛎️ 猫舍前台已经接手处理**\n\n请留意订单频道的后续更新。核对完成前不会擅自变更资金状态。',
    cancellationCompleted: '订单已经取消，相关预留猫条也已释放。',
    stateRefreshed: '订单刚刚有了新变化，面板已经为你刷新。',
    completionRequested: '**✨ 完成申请已经送达**\n\n**下一步**：等待客人确认。\n确认完成前，系统不会提前结算本单。'
  }
} as const;

export const botCopy = {
  onboarding: {
    registrationResult: (input: { applicant: boolean; created: boolean; rolePending: boolean }) =>
      input.applicant
        ? `**🎧 陪玩申请已送到猫舍前台**\n\n**当前状态**：等待审核\n${input.rolePending ? '你的玩家账户已经创建，身份信息仍在同步中。' : '审核期间，你仍然可以作为玩家正常使用平台。'}`
        : input.created
          ? `**🐾 欢迎成为黑猫电竞的新玩家**\n\n你的账户和猫条钱包已经准备好，现在可以开始寻找陪玩了。${input.rolePending ? '\n\n身份信息仍在同步中，不影响账户创建结果。' : ''}`
          : `**🐈‍⬛ 欢迎回来**\n\n你已经登记过玩家账户，可以直接开始找陪玩。${input.rolePending ? '\n\n身份信息仍在同步中，请稍后再试。' : ''}`
  },
  gifts: {
    affordable: (amount: string) => `**🎁 礼物已经选好**\n\n**本次需要**：${amount}\n请确认当前价格和赠送对象后送出。`,
    shortfall: (amount: string, instructions: string) =>
      `**🐟 可用猫条不足**\n\n**还差**：${amount}\n${instructions}完成后请刷新余额，再继续送出。`,
    catalogTarget: (displayName: string) => `**赠送对象**：${displayName}`,
    requestSubmitted: (giftName: string, amount: string) =>
      `**🎁 礼物已送到猫舍前台**\n\n**礼物**：${giftName}\n**已预留**：${amount}\n**当前进度**：等待猫舍前台核对\n\n核对完成前不会正式扣除。`
  },
  orders: {
    reviewExpectedAt: (expiresAt: string) => `预计复核时间：${expiresAt}`,
    conflictRefreshed: (requestId: string) =>
      `订单刚刚有了新变化，我们已经为你刷新到最新内容。request_id: ${requestId}`,
    incomplete: (requestId: string) => `委托信息还差一点，请补齐标出的内容后再确认。request_id: ${requestId}`,
    channelCreationFailed: (requestId: string, reportFailed = false) =>
      `无法创建订单频道，因此订单创建未继续。\n请将下方编号提供给猫舍前台。request_id: ${requestId}${reportFailed ? '\n故障记录也未能完成，请务必一并说明。' : ''}`,
    cancellationRefreshed: (requestId: string) =>
      `原取消说明已过期或订单已有新变化，我们已经刷新到最新影响。请核对后再次确认；本次刷新没有取消订单。request_id: ${requestId}`
  },
  dispatch: {
    accepted: (channelId: string) =>
      `**✅ 委托接取成功**\n\n请进入订单频道 <#${channelId}> 确认本人已就绪。本单全部有效陪玩确认前不会开始服务。`,
    alreadyAccepted: (channelId: string) =>
      `**🐾 这张委托已经接取**\n\n无需重复接单。请直接进入订单频道 <#${channelId}> 查看陪玩全员就绪进度。`,
    alreadyTaken: '这张委托已经被处理过了，当前席位可能已由其他陪玩接取。可以继续等待下一轮通知。',
    declined: '已记录本轮暂不接单，我们不会再用这轮委托打扰你。',
    ineligible: (reasons: string[], requestId: string) =>
      `**🐾 这张委托暂时无法接取**\n\n${reasons.length > 0 ? `**未满足条件**：${reasons.join('；')}。` : '你当前不在本轮可接单名单中，资格或订单状态可能刚刚发生了变化。'}\n\n请打开陪玩工作台检查状态，调整后等待下一轮通知。\nrequest_id: ${requestId}`
  },
  lifecycle: {
    completionConfirmed: (amount: string) =>
      `**✨ 本次陪伴已确认完成**\n\n**实际扣除**：${amount}\n陪玩收益也已记录。感谢你们今晚的相伴。`,
    confirmationRestricted: (requestId: string) =>
      `这个「确认完成」按钮需要由本单客人操作。陪玩提交完成申请后，请等待客人确认；如有异议可以点击「我要申诉」。request_id: ${requestId}`,
    completionRequestRestricted: (requestId: string) =>
      `这个「申请完成」按钮需要由本单陪玩操作。客人无需代为申请，请等待陪玩提交；如需协助可以点击「我要申诉」。request_id: ${requestId}`,
    readinessRestricted: (requestId: string) =>
      `只有本订单当前有效的陪玩可以确认本人就绪；老板无需提交就绪。如果你认为这是权限异常，请联系猫舍前台。request_id: ${requestId}`,
    supportRestricted: (requestId: string) =>
      `只有本订单的参与者可以从这里发起申诉。如需其他协助，请直接联系猫舍前台。request_id: ${requestId}`,
    appealSubmitted: (taskPublicId: string) =>
      `**🛎️ 猫舍前台已经收到**\n\n**客服任务**：${taskPublicId}\n我们会核对订单记录和双方说明，处理结果会同步到订单频道。`
  },
  entry: {
    channelCreated: (channelMention: string) =>
      `**🐾 专属猫窝已经准备好**\n\n**订单频道**：${channelMention}\n进入频道补充需求后，就可以提交委托。`,
    existingOrder: (channelId: string) => `**🐈‍⬛ 找到你进行中的委托了**\n\n回到原订单频道继续处理：<#${channelId}>`
  }
} as const;
