import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  SectionBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  UserSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions
} from 'discord.js';
import {
  assertDiscordMessageSpec,
  type ActionRowSpec,
  type ComponentSpec,
  type MessageComponentSpec,
  type MessageSpec,
  type ModalSpec,
  type TextInputSpec
} from './service-center-components.js';
export const BOT_SANDBOX_WARNING = 'SANDBOX 测试环境 · 测试余额不代表真实资金';

export function decorateSandboxPrivateMessage<
  T extends { visibility: 'EPHEMERAL' | 'PUBLIC' | 'PRIVATE_CHANNEL'; body: string }
>(message: T, environment: 'SANDBOX' | 'PRODUCTION'): T {
  if (environment !== 'SANDBOX') return message;
  return { ...message, body: `${BOT_SANDBOX_WARNING}\n\n${message.body}` };
}

export function sandboxDisplayRole(
  level: 'L1_SUPPORT' | 'L2_SUPERVISOR' | 'L3_OPERATIONS' | 'L4_ADMIN_OWNER' | null
): 'STAFF' | 'OWNER' | null {
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
  assertDiscordMessageSpec(message);
  const rendered = decorateSandboxPrivateMessage(message, rendererEnvironment);
  if (rendered.layout === 'COMPONENTS_V2' || rendered.visibility === 'PRIVATE_CHANNEL') {
    const container = new ContainerBuilder()
      .setAccentColor(rendered.visibility === 'PUBLIC' ? 0x5865f2 : 0x24c8c8)
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`-# ${rendered.title}\n## ${rendered.body}`.slice(0, 4000))
      );
    for (const component of rendered.components) addV2Component(container, component);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Blackcat Companion'));
    return {
      components: [container],
      flags:
        rendered.visibility === 'EPHEMERAL'
          ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
          : MessageFlags.IsComponentsV2
    };
  }
  return {
    embeds: [
      new EmbedBuilder()
        .setColor(rendered.visibility === 'PUBLIC' ? 0x5865f2 : 0x24c8c8)
        .setTitle(rendered.title.slice(0, 256))
        .setDescription(rendered.body.slice(0, 4096))
        .setFooter({ text: 'Blackcat Companion' })
    ],
    components: rendered.components
      .filter((component): component is ActionRowSpec => component.type === 'ACTION_ROW')
      .map(toDiscordActionRow),
    ephemeral: rendered.visibility === 'EPHEMERAL'
  };
}

export function toDiscordUpdate(message: MessageSpec): InteractionEditReplyOptions {
  const reply = toDiscordReply(message);
  if (message.layout === 'COMPONENTS_V2' || message.visibility === 'PRIVATE_CHANNEL') {
    return {
      content: null,
      embeds: [],
      components: reply.components,
      flags: MessageFlags.IsComponentsV2
    };
  }
  return {
    content: null,
    embeds: reply.embeds,
    components: reply.components
  };
}

function addV2Component(container: ContainerBuilder, component: MessageComponentSpec): void {
  if (component.type === 'ACTION_ROW') {
    container.addActionRowComponents(toDiscordActionRow(component));
    return;
  }
  if (component.type === 'V2_SECTION') {
    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(component.content.slice(0, 4000)))
        .setButtonAccessory(toDiscordComponent(component.accessory) as ButtonBuilder)
    );
    return;
  }
  if (component.type === 'V2_TEXT') {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(component.content.slice(0, 4000)));
    return;
  }
  container.addSeparatorComponents((separator) => separator.setDivider(true));
}

export function toDiscordModal(modal: ModalSpec): ModalBuilder {
  return new ModalBuilder()
    .setTitle(modal.title)
    .setCustomId(modal.customId)
    .addComponents(modal.components.map(toDiscordTextInputRow));
}

function toDiscordActionRow(
  row: ActionRowSpec
): ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder | UserSelectMenuBuilder> {
  return new ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder | UserSelectMenuBuilder>().addComponents(
    row.components.map(toDiscordComponent)
  );
}

function toDiscordComponent(component: ComponentSpec): ButtonBuilder | StringSelectMenuBuilder | UserSelectMenuBuilder {
  if (component.type === 'LINK_BUTTON') {
    return new ButtonBuilder()
      .setLabel(component.label)
      .setURL(component.url)
      .setStyle(ButtonStyle.Link)
      .setDisabled(component.disabled ?? false);
  }
  if (component.type === 'BUTTON') {
    return new ButtonBuilder()
      .setCustomId(component.customId)
      .setLabel(component.label)
      .setStyle(toButtonStyle(component.style))
      .setDisabled(component.disabled ?? false);
  }
  if (component.type === 'USER_SELECT') {
    return new UserSelectMenuBuilder()
      .setCustomId(component.customId)
      .setPlaceholder(component.placeholder)
      .setMinValues(component.minValues)
      .setMaxValues(component.maxValues)
      .setDisabled(component.disabled ?? false);
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(component.customId)
    .setPlaceholder(component.placeholder)
    .setDisabled(component.disabled ?? false)
    .addOptions(component.options);
  if (component.minValues !== undefined) select.setMinValues(component.minValues);
  if (component.maxValues !== undefined) select.setMaxValues(component.maxValues);
  return select;
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
