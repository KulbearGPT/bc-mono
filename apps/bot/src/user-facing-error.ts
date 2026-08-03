interface ApiErrorShape {
  code: string;
  message: string;
  requestId: string;
  statusCode?: number;
}

export interface UserFacingErrorOptions {
  operation: string;
  localRequestId?: string;
}

interface ErrorExplanation {
  reason: string;
  nextStep: string;
}

const uncertainCodes = new Set(['GATEWAY_TIMEOUT', 'SERVICE_UNAVAILABLE', 'INVALID_RESPONSE']);

const exactExplanations: ReadonlyArray<[RegExp, ErrorExplanation]> = [
  [
    /Only the order owner can manage the selection pool\./iu,
    {
      reason: '当前 Discord 账号不是该订单的客户所有者。',
      nextStep: '请使用创建该订单的客户账号操作；工作人员和其他频道成员不能代替客户管理报名轮次。'
    }
  ],
  [
    /Only the order owner can close early\./iu,
    {
      reason: '当前 Discord 账号不是该订单的客户所有者，因此不能终止招募。',
      nextStep: '请由创建该订单的客户账号在订单面板手动操作。'
    }
  ],
  [
    /Order is not visible to the current actor\./iu,
    {
      reason: '当前账号无权查看该订单，或该订单不属于当前服务器。',
      nextStep: '请确认使用了订单参与者账号并在订单所属服务器内操作；工作人员请通过获授权的客服入口处理。'
    }
  ],
  [
    /Order or selection pool version is stale\./iu,
    {
      reason: '页面中的订单或报名轮次已经过期，当前状态已被其他操作更新。',
      nextStep: '请重新打开订单面板，核对最新状态后再决定是否继续。'
    }
  ],
  [
    /Selection pool or application is stale\./iu,
    {
      reason: '页面中的报名轮次或报名记录版本已经过期，当前状态已被其他操作更新。',
      nextStep: '请从最新报名卡重新查看状态；不要继续使用旧消息中的撤回或报名组件。'
    }
  ],
  [
    /waitMinutes must be between 1 and 30\./iu,
    {
      reason: '提交的等待时间不符合要求，只能选择 1 到 30 分钟。',
      nextStep: '请重新打开等待时间菜单并选择有效时长。'
    }
  ],
  [
    /Only a pending order can open a selection pool\./iu,
    {
      reason: '当前订单已不在等待派单状态，不能开启新一轮报名。',
      nextStep: '请重新打开订单面板查看当前状态，并使用面板提供的下一步操作。'
    }
  ],
  [
    /Selection pool was not found\./iu,
    {
      reason: '报名轮次不存在、已结束，或当前账号无权查看。',
      nextStep: '请从最新订单面板重新进入报名流程；不要继续使用旧消息中的组件。'
    }
  ],
  [
    /Insufficient available balance\./iu,
    {
      reason: '账户可用余额不足，无法完成当前金额操作。',
      nextStep: '请先查看余额与现有预留；完成充值或释放其他预留后，再从最新面板操作。'
    }
  ],
  [
    /The operation failed before it could be completed\./iu,
    {
      reason: '系统暂时未能完成操作，也没有返回可确认的结果。',
      nextStep: '请先查看最新状态，不要连续操作，并将下方编号提供给管理员查询处理记录。'
    }
  ]
];

const codeExplanations: Readonly<Record<string, ErrorExplanation>> = {
  AUTHENTICATION_FAILED: {
    reason: '系统服务身份验证失败。',
    nextStep: '请联系管理员处理服务连接配置；普通用户重复操作不会解决该问题。'
  },
  PERMISSION_DENIED: {
    reason: '当前 Discord 账号没有执行此操作所需的权限或对象归属。',
    nextStep: '请确认使用正确的账号和入口；如认为权限应当具备，请联系猫舍前台核对账号绑定。'
  },
  ACCOUNT_NOT_BOUND: {
    reason: '当前 Discord 账号尚未绑定客户账户。',
    nextStep: '请先从新人入口完成客户注册；如已经注册，请联系猫舍前台核对账号绑定。'
  },
  AUTH_REQUIRED: {
    reason: '系统无法从当前 Discord 身份确认有效账户。',
    nextStep: '请在服务器内使用已注册账号操作；如账号已注册，请联系猫舍前台核对绑定。'
  },
  NOT_FOUND: {
    reason: '目标记录不存在、已失效，或当前账号无权查看。',
    nextStep: '请从最新面板重新进入；不要继续使用旧消息中的组件。'
  },
  CONFLICT: {
    reason: '页面所依据的状态已经发生变化，本次请求与最新状态冲突。',
    nextStep: '请重新打开对应面板，核对最新状态后再操作。'
  },
  STALE_VERSION: {
    reason: '当前页面版本已经过期，对象状态已被其他操作更新。',
    nextStep: '请重新打开对应面板，核对最新状态后再操作。'
  },
  IDEMPOTENCY_CONFLICT: {
    reason: '同一个操作编号此前已用于不同操作，系统为避免重复执行而拒绝处理。',
    nextStep: '请关闭旧面板并从最新入口重新发起操作；不要重复点击原组件。'
  },
  VALIDATION_ERROR: {
    reason: '提交的内容未通过校验。',
    nextStep: '请按界面要求检查输入；如果输入来自旧组件，请重新打开最新面板。'
  },
  BUSINESS_RULE_ERROR: {
    reason: '当前业务状态不满足执行条件。',
    nextStep: '请重新打开对应面板查看当前状态和可用操作。'
  },
  INSUFFICIENT_FUNDS: {
    reason: '账户可用余额不足。',
    nextStep: '请查看余额和现有预留，完成充值或释放其他预留后再操作。'
  },
  RATE_LIMITED: {
    reason: '当前账号在短时间内操作过于频繁，系统已暂缓处理。',
    nextStep: '请停止连续点击，等待限流窗口结束后从最新面板操作一次。'
  },
  GATEWAY_TIMEOUT: {
    reason: '系统在时限内没有响应。',
    nextStep: '请先重新打开订单查看最新状态，不要连续提交；若状态未变化，再使用同一入口操作一次。'
  },
  SERVICE_UNAVAILABLE: {
    reason: '当前服务暂时无法连接。',
    nextStep: '请先重新打开订单查看最新状态，不要连续提交；连接恢复后再从最新面板继续。'
  },
  INVALID_RESPONSE: {
    reason: '系统返回了无法确认的结果。',
    nextStep: '请先重新打开订单查看最新状态，不要连续提交，并将下方编号提供给管理员排查。'
  }
};

export function formatUserFacingError(error: unknown, options: UserFacingErrorOptions): string {
  if (!isApiError(error)) {
    const requestId = cleanRequestId(options.localRequestId ?? 'local-unhandled-error');
    const detail = '系统发生未分类异常，当前无法确认详细原因。';
    return [
      `⚠️ 无法${options.operation}`,
      `**原因**\n${detail}`,
      '**下一步**\n请先查看最新状态，不要连续操作，并将下方编号提供给管理员。',
      '**写入结果**\n无法确认本次请求是否已送达。',
      `request_id: ${requestId}`
    ].join('\n\n');
  }

  const explanation = explainApiError(error);
  const uncertain = uncertainCodes.has(error.code) || (error.statusCode ?? 500) >= 500;
  const outcome = uncertain
    ? '由于没有收到可信的业务结果，写入结果暂时无法确认。'
    : '系统已拒绝本次请求，本次操作未生效。';
  return [
    `⚠️ 无法${options.operation}`,
    `**原因**\n${explanation.reason}`,
    `**下一步**\n${explanation.nextStep}`,
    `**写入结果**\n${outcome}`,
    `request_id: ${cleanRequestId(error.requestId)}`
  ].join('\n\n');
}

export function formatDiscordError(error: unknown, operation: string, interactionId: string): string {
  return formatUserFacingError(error, {
    operation,
    localRequestId: `discord-interaction-${interactionId}`
  });
}

export function formatUnexpectedBotResult(operation: string, requestId: string): string {
  return [
    `⚠️ 无法${operation}`,
    '**原因**\n当前操作没有返回可确认的结果。',
    '**下一步**\n请重新打开对应面板，并将下方编号提供给管理员处理。',
    '**写入结果**\n当前页面无法确认最新业务状态。',
    `request_id: ${cleanRequestId(requestId)}`
  ].join('\n\n');
}

function explainApiError(error: ApiErrorShape): ErrorExplanation {
  const exact = exactExplanations.find(([pattern]) => pattern.test(error.message));
  if (exact) return exact[1];
  const byCode = codeExplanations[error.code];
  if (!byCode) {
    return {
      reason: `系统暂时无法完成此操作（错误代码 ${cleanCode(error.code)}）。`,
      nextStep: '请重新打开对应面板查看最新状态；如仍无法处理，请将下方编号提供给猫舍前台。'
    };
  }
  return byCode;
}

function isApiError(error: unknown): error is ApiErrorShape {
  if (!error || typeof error !== 'object') return false;
  const value = error as Partial<ApiErrorShape>;
  return (
    typeof value.code === 'string' &&
    typeof value.message === 'string' &&
    typeof value.requestId === 'string' &&
    (value.statusCode === undefined || typeof value.statusCode === 'number')
  );
}

function cleanRequestId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/gu, '').slice(0, 128);
  return normalized || 'unknown';
}

function cleanCode(value: string): string {
  const normalized = value.replace(/[^A-Z0-9_]/gu, '').slice(0, 80);
  return normalized || 'UNKNOWN_ERROR';
}
