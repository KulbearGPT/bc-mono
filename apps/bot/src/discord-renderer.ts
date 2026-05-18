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

export function toDiscordReply(message: MessageSpec): InteractionReplyOptions {
  return {
    content: `**${message.title}**\n${message.body}`,
    components: message.components.map(toDiscordActionRow),
    ephemeral: message.visibility === 'EPHEMERAL'
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
