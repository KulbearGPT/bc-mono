import type { Command } from '@sapphire/framework';
import { buildBotActorContext } from './actor-context.js';
import { botConfigApi } from './bot-config.js';
import { formatUserFacingError } from './user-facing-error.js';
import { isWelcomeDmBlocked, resendWelcomeDm, type WelcomeDmAuthorizationApi } from './welcome-dm.js';

export async function executeWelcomeCommand(
  interaction: Command.ChatInputCommandInteraction,
  api: WelcomeDmAuthorizationApi = botConfigApi
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({ content: '请在服务器内使用迎新指令。', ephemeral: true });
    return;
  }
  const target = interaction.options.getUser('player', true);
  await interaction.deferReply({ ephemeral: true });
  try {
    const actor = buildBotActorContext(interaction);
    if (!actor) throw new Error('Guild Actor Context is required.');
    const result = await resendWelcomeDm({
      actor,
      guild: interaction.guild,
      targetUserId: target.id,
      api
    });
    await interaction.editReply(
      result.sent ? `迎新私信已重新发送给 ${target.username}。` : '目标账号是 Bot，不发送迎新私信。'
    );
  } catch (error) {
    interaction.client.logger.error({
      event: 'bot.welcome_dm.command_failed',
      guildId: interaction.guildId,
      actorDiscordUserId: interaction.user.id,
      targetDiscordUserId: target.id,
      error
    });
    await interaction.editReply(
      isWelcomeDmBlocked(error)
        ? '无法发送迎新私信：该玩家目前关闭了服务器成员私信。请让玩家开启私信后再重试。'
        : formatUserFacingError(error, {
            operation: '重新发送迎新私信',
            localRequestId: `discord-interaction-${interaction.id}`
          })
    );
  }
}
