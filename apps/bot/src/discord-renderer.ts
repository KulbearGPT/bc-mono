import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type InteractionReplyOptions
} from 'discord.js';
import type { ActionRowSpec, ComponentSpec, MessageSpec, ModalSpec, TextInputSpec } from './service-center.js';

export const BOT_SANDBOX_WARNING = 'SANDBOX 测试环境 · 测试余额不代表真实资金';

export function decorateSandboxPrivateMessage<T extends { visibility: 'EPHEMERAL' | 'PUBLIC' | 'PRIVATE_CHANNEL'; body: string }>(
  message: T,
  environment: 'SANDBOX' | 'PRODUCTION'
): T {
  if (environment !== 'SANDBOX' || message.visibility === 'PUBLIC') return message;
  return { ...message, body: `${BOT_SANDBOX_WARNING}\n\n${message.body}` };
}

export function sandboxDisplayRole(level: 'L1_SUPPORT' | 'L2_SUPERVISOR' | 'L3_OPERATIONS' | 'L4_ADMIN_OWNER' | null): 'STAFF' | 'OWNER' | null {
  if (level === 'L2_SUPERVISOR') return 'STAFF';
  if (level === 'L4_ADMIN_OWNER') return 'OWNER';
  return null;
}

let rendererEnvironment: 'SANDBOX' | 'PRODUCTION' = 'PRODUCTION';

export function configureDiscordRendererEnvironment(value: string | undefined): void {
  if (value !== 'SANDBOX' && value !== 'PRODUCTION') {
    throw new Error('BUSINESS_ENV must be explicitly set to SANDBOX or PRODUCTION.');
  }
  rendererEnvironment = value;
}

export function toDiscordReply(message: MessageSpec): InteractionReplyOptions {
  const rendered = decorateSandboxPrivateMessage(message, rendererEnvironment);
  return {
    content: `**${rendered.title}**\n${rendered.body}`,
    components: rendered.components.map(toDiscordActionRow),
    ephemeral: rendered.visibility === 'EPHEMERAL'
  };
}

export function toDiscordModal(modal: ModalSpec): ModalBuilder {
  return new ModalBuilder()
    .setTitle(modal.title)
    .setCustomId(modal.customId)
    .addComponents(modal.components.map(toDiscordTextInputRow));
}

function toDiscordActionRow(row: ActionRowSpec): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder> {
  return new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>().addComponents(
    row.components.map(toDiscordComponent)
  );
}

function toDiscordComponent(component: ComponentSpec): ButtonBuilder | StringSelectMenuBuilder {
  if (component.type === 'LINK_BUTTON') {
    return new ButtonBuilder().setLabel(component.label).setURL(component.url).setStyle(ButtonStyle.Link).setDisabled(component.disabled ?? false);
  }
  if (component.type === 'BUTTON') {
    return new ButtonBuilder()
      .setCustomId(component.customId)
      .setLabel(component.label)
      .setStyle(toButtonStyle(component.style))
      .setDisabled(component.disabled ?? false);
  }

  return new StringSelectMenuBuilder()
    .setCustomId(component.customId)
    .setPlaceholder(component.placeholder)
    .setDisabled(component.disabled ?? false)
    .addOptions(component.options);
}

function toButtonStyle(style: 'PRIMARY' | 'SECONDARY' | 'DANGER'): ButtonStyle {
  if (style === 'PRIMARY') {
    return ButtonStyle.Primary;
  }
  if (style === 'DANGER') {
    return ButtonStyle.Danger;
  }
  return ButtonStyle.Secondary;
}

function toDiscordTextInputRow(input: TextInputSpec): ActionRowBuilder<TextInputBuilder> {
  return new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder()
      .setCustomId(input.customId)
      .setLabel(input.label)
      .setStyle(input.style === 'PARAGRAPH' ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(input.required)
      .setMaxLength(input.maxLength)
  );
}
