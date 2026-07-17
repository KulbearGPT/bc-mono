/**
 * Long-form, user-facing Bot copy.
 *
 * Short component labels such as “确认” and “取消” stay beside their
 * components. This catalog contains complete messages that are reviewed and
 * rewritten as a unit; it is intentionally not an i18n layer.
 */
export const BOT_COPY = {
  onboarding: {
    welcome:
      '**🐈 欢迎来到黑猫电竞**\n\n今晚想找一位合拍的游戏搭子，还是申请加入我们的陪玩猫舍？\n第一次来的客人可以先完成登记，我们会为你准备账户和猫条钱包。注册后即可开始找陪玩；提交陪玩申请后，猫舍前台会为你完成认证。',
    invalidEntryChannel: '新人入口目前不可用，请联系管理员检查 Bot 的频道读写权限。'
  },
  gifts: {
    staleBalance: '🐟 猫条余额需要刷新\n当前余额信息已经过期，刷新后即可继续确认礼物。'
  },
  orders: {
    publicEntryIntroduction:
      '今晚想找一位合拍的游戏搭子？从这里提交委托即可。每位客人同一时间只能有一个进行中的订单；如果已有订单，我们会带你回到原频道。',
    matchingUnavailable: '🐾 暂时没有拿到最新匹配进度\n请稍后刷新；你的订单和已预留猫条不会因此重复处理。',
    reviewPaused: '🐾 这笔订单已交由猫舍前台照看。',
    reviewInProgress: '自动派单和超时处理已暂停，客服正在核对具体情况，请等待处理结果。',
    completionPending: '✨ 陪玩已经提交完成申请\n现在等待客人确认；如对服务情况有疑问，也可以联系猫舍前台处理。',
    staffReviewScope: '客服会核对订单记录、语音频道和双方说明；核对期间不会自动取消、退款或扣罚任何一方。',
    reservationOnly: '目前只是预留本单所需猫条，还没有产生正式消费。',
    dispatchStarted:
      '🐈 猫舍正在为你寻找合适的陪玩。我们会通知符合条件且在线可接单的成员；服务开始前取消订单，预留猫条会按规则释放。',
    accountUnavailable: '账户还没有准备好，请联系猫舍前台协助开通。',
    cancellationEscalated: '🐾 猫舍前台已经接手处理\n请留意订单频道的后续更新；核对完成前不会擅自变更资金状态。',
    cancellationCompleted: '订单已经取消，相关预留猫条也已释放。',
    stateRefreshed: '订单刚刚有了新变化，面板已经为你刷新。',
    completionRequested: '✨ 完成申请已经送达\n现在等待客人确认；确认完成前，系统不会提前结算本单。'
  }
} as const;

export const botCopy = {
  onboarding: {
    registrationResult: (input: { applicant: boolean; created: boolean; rolePending: boolean }) =>
      input.applicant
        ? `🐈 陪玩申请已经送到猫舍前台\n当前状态：等待审核。${input.rolePending ? '你的客人账户已经创建，身份信息仍在同步中。' : '审核期间，你仍然可以作为客人正常使用平台。'}`
        : input.created
          ? `🐾 欢迎成为黑猫电竞的新客人\n你的账户和猫条钱包已经准备好，现在可以开始寻找陪玩了。${input.rolePending ? '\n身份信息仍在同步中，不影响账户创建结果。' : ''}`
          : `欢迎回来，你已经登记过客人账户，可以直接开始找陪玩。${input.rolePending ? '\n身份信息仍在同步中，请稍后再试。' : ''}`
  },
  gifts: {
    affordable: (amount: string) => `🎁 礼物已经选好\n本次需要 ${amount}，请确认当前价格和赠送对象后送出。`,
    shortfall: (amount: string, instructions: string) =>
      `🐟 猫条好像不太够\n这份礼物还差 ${amount}。${instructions}完成后刷新余额，就可以继续送出。`,
    catalogTarget: (displayName: string) => `这份礼物将送给：${displayName}`,
    requestSubmitted: (giftName: string, amount: string) =>
      `🎁 礼物已经装进猫爪包裹\n「${giftName}」已预留 ${amount}，正在等待猫舍前台核对。核对完成前不会正式扣除。`
  },
  orders: {
    reviewExpectedAt: (expiresAt: string) => `预计复核时间：${expiresAt}`,
    conflictRefreshed: (requestId: string) =>
      `订单刚刚有了新变化，我们已经为你刷新到最新内容。request_id: ${requestId}`,
    incomplete: (requestId: string) => `委托信息还差一点，请补齐标出的内容后再确认。request_id: ${requestId}`,
    channelCreationFailed: (requestId: string, reportFailed = false) =>
      `无法创建订单频道：Discord 没有返回可用的私密频道，因此订单创建未继续。\n请联系猫舍前台检查 Bot 的频道创建与权限覆盖权限。request_id: ${requestId}${reportFailed ? '\n业务 API 也未能记录频道故障；请务必把这个编号提供给客服。' : ''}`,
    cancellationChanged: (requestId: string) =>
      `订单状态刚刚发生变化，请刷新取消说明，确认最新影响后再试。request_id: ${requestId}`
  },
  dispatch: {
    accepted: (channelId: string) =>
      `🐈 委托接取成功\n这位客人今晚就交给你啦。请进入订单频道 <#${channelId}>，等待双方完成准备确认；确认前不会开始服务。`,
    alreadyAccepted: (channelId: string) =>
      `🐾 你已经接过这张委托啦\n不用重复接单，请直接进入订单频道 <#${channelId}>，等待双方完成准备确认。`,
    alreadyTaken: '这张委托已经被处理过了，当前席位可能已由其他陪玩接取。可以继续等待下一轮通知。',
    declined: '已记录本轮暂不接单，我们不会再用这轮委托打扰你。',
    ineligible: (reasons: string[], requestId: string) =>
      `🐾 这张委托暂时接不了\n${reasons.length > 0 ? `当前未满足：${reasons.join('；')}。` : '你当前不在本轮可接单名单中，资格或订单状态可能刚刚发生了变化。'}\n请打开陪玩工作台检查状态，调整后等待下一轮通知。request_id: ${requestId}`
  },
  lifecycle: {
    completionConfirmed: (amount: string) =>
      `✨ 本次陪伴已经确认完成\n已扣除 ${amount}，陪玩收益也已记录。感谢你们今晚的相伴。`,
    confirmationRestricted: (requestId: string) =>
      `这个「确认完成」按钮需要由本单客人操作。陪玩提交完成申请后，请等待客人确认；如有异议可以点击「我要申诉」。request_id: ${requestId}`,
    completionRequestRestricted: (requestId: string) =>
      `这个「申请完成」按钮需要由本单陪玩操作。客人无需代为申请，请等待陪玩提交；如需协助可以点击「我要申诉」。request_id: ${requestId}`,
    readinessRestricted: (requestId: string) =>
      `只有本订单的客人和已接单陪玩可以确认就绪。如果你认为这是权限异常，请联系猫舍前台。request_id: ${requestId}`,
    supportRestricted: (requestId: string) =>
      `只有本订单的参与者可以从这里发起申诉。如需其他协助，请直接联系猫舍前台。request_id: ${requestId}`,
    appealSubmitted: (taskPublicId: string) =>
      `🛎️ 猫舍前台已经收到\n客服任务 ${taskPublicId} 已创建。我们会核对订单记录和双方说明，处理结果会同步到订单频道。`
  },
  entry: {
    channelCreated: (channelMention: string) =>
      `🐾 猫窝已经为你收拾好了\n订单频道已创建：${channelMention}\n进入频道补充需求后，就可以提交委托。`,
    existingOrder: (channelId: string) => `你已经有一笔进行中的委托，我们带你回到原来的猫窝：<#${channelId}>`
  }
} as const;
