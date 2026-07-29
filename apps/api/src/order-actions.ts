export type OrderActionRole = 'CUSTOMER' | 'PLAYER' | 'STAFF';
export type OrderActionRisk = 'PRIMARY' | 'SECONDARY' | 'DANGER';

export type OrderAvailableActionKey =
  | 'CUSTOMER_CONTINUE_ORDER'
  | 'CUSTOMER_STOP_RECRUITMENT'
  | 'CUSTOMER_CONFIRM_PLAYERS'
  | 'CUSTOMER_CONFIRM_COMPLETION'
  | 'CUSTOMER_SEND_GIFT'
  | 'CUSTOMER_CANCEL_ORDER'
  | 'CUSTOMER_REQUEST_CANCELLATION'
  | 'CUSTOMER_VIEW_CANCELLATION_STATUS'
  | 'CUSTOMER_START_NEW_ORDER'
  | 'CUSTOMER_REFRESH_ORDER'
  | 'CUSTOMER_CONTACT_SUPPORT'
  | 'PLAYER_OPEN_CURRENT_ORDER'
  | 'PLAYER_SET_READINESS'
  | 'PLAYER_REQUEST_COMPLETION'
  | 'PLAYER_REFRESH_WORKBENCH'
  | 'PLAYER_CONTACT_SUPPORT'
  | 'STAFF_OPEN_ORDER'
  | 'STAFF_REFRESH_ORDER';

export interface OrderAvailableAction {
  key: OrderAvailableActionKey;
  role: OrderActionRole;
  enabled: boolean;
  risk: OrderActionRisk;
  reasonCode: string | null;
}

export interface BuildOrderAvailableActionsInput {
  status: string;
  role: OrderActionRole;
  hasOpenCancellationAssist?: boolean;
}

export function buildOrderAvailableActions(input: BuildOrderAvailableActionsInput): OrderAvailableAction[] {
  if (input.role === 'PLAYER') return playerActions(input.status);
  if (input.role === 'STAFF') {
    return [action('STAFF_OPEN_ORDER', 'STAFF', 'PRIMARY'), action('STAFF_REFRESH_ORDER', 'STAFF', 'SECONDARY')];
  }

  const actions: OrderAvailableAction[] = [];
  if (input.status === 'DRAFT') {
    actions.push(action('CUSTOMER_CONTINUE_ORDER', 'CUSTOMER', 'PRIMARY'));
  } else if (input.status === 'PENDING_DISPATCH') {
    actions.push(action('CUSTOMER_STOP_RECRUITMENT', 'CUSTOMER', 'PRIMARY'));
  } else if (input.status === 'PENDING_CONFIRMATION') {
    actions.push(action('CUSTOMER_CONFIRM_COMPLETION', 'CUSTOMER', 'PRIMARY'));
  } else if (input.status === 'IN_SERVICE') {
    actions.push(action('CUSTOMER_SEND_GIFT', 'CUSTOMER', 'SECONDARY'));
  } else if (input.status === 'COMPLETED' || input.status === 'CANCELLED') {
    actions.push(action('CUSTOMER_START_NEW_ORDER', 'CUSTOMER', 'PRIMARY'));
  }

  if (!['COMPLETED', 'CANCELLED'].includes(input.status)) {
    if (input.hasOpenCancellationAssist) {
      actions.push(action('CUSTOMER_VIEW_CANCELLATION_STATUS', 'CUSTOMER', 'SECONDARY'));
    } else if (input.status === 'DRAFT' || input.status === 'PENDING_DISPATCH') {
      actions.push(action('CUSTOMER_CANCEL_ORDER', 'CUSTOMER', 'DANGER'));
    } else {
      actions.push(action('CUSTOMER_REQUEST_CANCELLATION', 'CUSTOMER', 'DANGER'));
    }
    actions.push(action('CUSTOMER_REFRESH_ORDER', 'CUSTOMER', 'SECONDARY'));
  }
  actions.push(action('CUSTOMER_CONTACT_SUPPORT', 'CUSTOMER', 'SECONDARY'));
  return actions;
}

function playerActions(status: string): OrderAvailableAction[] {
  const actions: OrderAvailableAction[] = [];
  if (['ACCEPTED', 'IN_SERVICE', 'PENDING_CONFIRMATION'].includes(status)) {
    actions.push(action('PLAYER_OPEN_CURRENT_ORDER', 'PLAYER', 'SECONDARY'));
  }
  if (status === 'ACCEPTED') {
    actions.push(action('PLAYER_SET_READINESS', 'PLAYER', 'PRIMARY'));
  } else if (status === 'IN_SERVICE') {
    actions.push(action('PLAYER_REQUEST_COMPLETION', 'PLAYER', 'PRIMARY'));
  }
  actions.push(action('PLAYER_REFRESH_WORKBENCH', 'PLAYER', 'SECONDARY'));
  actions.push(action('PLAYER_CONTACT_SUPPORT', 'PLAYER', 'SECONDARY'));
  return actions;
}

function action(key: OrderAvailableActionKey, role: OrderActionRole, risk: OrderActionRisk): OrderAvailableAction {
  return { key, role, enabled: true, risk, reasonCode: null };
}
