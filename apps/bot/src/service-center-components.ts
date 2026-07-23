import type { OrderSummary } from './service-center-api.js';

export function paginationCustomId(prefix: string, cursor: string): string {
  if (!/^c1_[A-Za-z0-9_-]{20,70}$/u.test(cursor)) throw new Error('API pagination cursor is invalid.');
  const customId = `${prefix}:${cursor}`;
  if (customId.length > 100) throw new Error('Discord pagination custom ID exceeds 100 characters.');
  return customId;
}

export interface ActionRowSpec {
  type: 'ACTION_ROW';
  components: ComponentSpec[];
}

export interface V2SectionSpec {
  type: 'V2_SECTION';
  content: string;
  accessory: Extract<ComponentSpec, { type: 'BUTTON' }>;
}

export interface V2TextSpec {
  type: 'V2_TEXT';
  content: string;
}

export interface V2SeparatorSpec {
  type: 'V2_SEPARATOR';
}

export type MessageComponentSpec = ActionRowSpec | V2SectionSpec | V2TextSpec | V2SeparatorSpec;

export type ComponentSpec =
  | {
      type: 'BUTTON';
      style: 'PRIMARY' | 'SECONDARY' | 'DANGER';
      customId: string;
      label: string;
      disabled?: boolean;
    }
  | {
      type: 'LINK_BUTTON';
      style: 'LINK';
      url: string;
      label: string;
      disabled?: boolean;
    }
  | {
      type: 'STRING_SELECT';
      customId: string;
      placeholder: string;
      options: Array<{
        label: string;
        value: string;
        description?: string;
        default?: boolean;
      }>;
      minValues?: number;
      maxValues?: number;
      disabled?: boolean;
    }
  | {
      type: 'USER_SELECT';
      customId: string;
      placeholder: string;
      minValues: number;
      maxValues: number;
      disabled?: boolean;
    };

export interface MessageSpec {
  title: string;
  body: string;
  visibility: 'PUBLIC' | 'EPHEMERAL' | 'PRIVATE_CHANNEL';
  components: MessageComponentSpec[];
  layout?: 'EMBED' | 'COMPONENTS_V2';
  tone?: MessageTone;
  density?: MessageDensity;
  fields?: MessageFieldSpec[];
  footer?: string;
}

export type MessageTone = 'BRAND' | 'INFO' | 'SUCCESS' | 'WAITING' | 'DANGER' | 'MUTED';

export type MessageDensity =
  'PUBLIC_WELCOME' | 'PUBLIC_MILESTONE' | 'PRIVATE_ORDER' | 'EPHEMERAL_FEEDBACK' | 'HIGH_RISK';

export interface MessageFieldSpec {
  name: string;
  value: string;
  inline?: boolean;
}

export interface ModalSpec {
  title: string;
  customId: string;
  components: TextInputSpec[];
}

export interface TextInputSpec {
  type: 'TEXT_INPUT';
  customId: string;
  label: string;
  style: 'SHORT' | 'PARAGRAPH';
  required: boolean;
  maxLength: number;
}

export type PermissionName = 'VIEW_CHANNEL' | 'SEND_MESSAGES' | 'MANAGE_CHANNELS';

export interface PermissionOverwriteSpec {
  id: string;
  kind: 'ROLE' | 'MEMBER';
  allow: PermissionName[];
  deny: PermissionName[];
}

export interface PrivateOrderChannelPlan {
  name: string;
  pinPanel: boolean;
  permissionOverwrites: PermissionOverwriteSpec[];
}

export interface AcceptedPlayerChannelPermissionPlan {
  channelId: string;
  permissionOverwrites: PermissionOverwriteSpec[];
}

export type BotFlowResult =
  | { kind: 'SHOW_MODAL'; modal: ModalSpec }
  | { kind: 'SHOW_SERVICE_CENTER'; message: MessageSpec }
  | { kind: 'SHOW_PLAYER_WORKBENCH'; message: MessageSpec }
  | { kind: 'SHOW_SUPPORT_RATING'; message: MessageSpec }
  | { kind: 'OPEN_EXISTING_CHANNEL'; channelId: string; orderId: string }
  | {
      kind: 'CREATE_PRIVATE_CHANNEL';
      order: OrderSummary;
      message: MessageSpec;
    }
  | { kind: 'CHANNEL_CREATION_FAILED'; message: string }
  | { kind: 'EDIT_ORIGINAL_MESSAGE'; message: MessageSpec; notice?: string }
  | { kind: 'EPHEMERAL_MESSAGE'; message: string };

export function assertDiscordMessageSpec(message: MessageSpec): void {
  if ([...message.title].length > 256) throw new Error('Discord message title exceeds 256 characters.');
  if ([...message.body].length > 4096) throw new Error('Discord message body exceeds 4096 characters.');
  if (message.fields && message.fields.length > 25) throw new Error('Discord embed exceeds 25 fields.');
  for (const field of message.fields ?? []) {
    if ([...field.name].length < 1 || [...field.name].length > 256)
      throw new Error('Discord embed field name must contain 1 to 256 characters.');
    if ([...field.value].length < 1 || [...field.value].length > 1024)
      throw new Error('Discord embed field value must contain 1 to 1024 characters.');
  }
  if (message.footer && [...message.footer].length > 2048)
    throw new Error('Discord embed footer exceeds 2048 characters.');
  for (const item of message.components) {
    if (item.type === 'ACTION_ROW') assertActionRow(item);
    if (item.type === 'V2_SECTION') assertInteractiveComponent(item.accessory);
  }
}

function assertActionRow(row: ActionRowSpec): void {
  if (row.components.length < 1 || row.components.length > 5) {
    throw new Error('Discord action row must contain 1 to 5 components.');
  }
  const selects = row.components.filter(
    (component) => component.type === 'STRING_SELECT' || component.type === 'USER_SELECT'
  );
  if (selects.length > 0 && row.components.length !== 1) {
    throw new Error('Discord select menus must be the only component in an action row.');
  }
  for (const component of row.components) assertInteractiveComponent(component);
}

function assertInteractiveComponent(component: ComponentSpec): void {
  if (component.type !== 'LINK_BUTTON') {
    if (component.customId.length < 1) throw new Error('Discord custom ID must not be empty.');
    if (component.customId.length > 100) throw new Error('Discord custom ID exceeds 100 characters.');
  }
  if (component.type === 'STRING_SELECT' && (component.options.length < 1 || component.options.length > 25)) {
    throw new Error('Discord string select must contain 1 to 25 options.');
  }
}
