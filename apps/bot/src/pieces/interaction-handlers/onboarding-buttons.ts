import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { Interaction } from 'discord.js';
import { buildBotActorContext } from '../../actor-context.js';
import { botCopy } from '../../bot-copy.js';
import {
  APPLY_COMPANION_CUSTOM_ID,
  REGISTER_PLAYER_CUSTOM_ID,
  reconcileProductRoleTasks,
  type CompanionApplicationResult
} from '../../onboarding.js';
import { getBotRuntimeDependencies } from '../../runtime-dependencies.js';
import { formatUserFacingError } from '../../user-facing-error.js';

export default class OnboardingButtonHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.Button });
  }
  public override parse(interaction: Interaction) {
    return interaction.isButton() &&
      (interaction.customId === REGISTER_PLAYER_CUSTOM_ID || interaction.customId === APPLY_COMPANION_CUSTOM_ID)
      ? this.some(interaction.customId)
      : this.none();
  }
  public override async run(interaction: Interaction, customId?: string): Promise<void> {
    if (!interaction.isButton() || !interaction.inGuild() || !interaction.guild || !customId) return;
    await interaction.deferReply({ ephemeral: true });
    const baseActor = buildBotActorContext(interaction);
    if (!baseActor) return;
    const actor = {
      ...baseActor,
      displayName:
        interaction.member && 'displayName' in interaction.member
          ? String(interaction.member.displayName)
          : (interaction.user.globalName ?? interaction.user.username)
    };
    try {
      const onboardingApi = getBotRuntimeDependencies().onboardingApi;
      const result =
        customId === APPLY_COMPANION_CUSTOM_ID
          ? await onboardingApi.applyForCompanion(actor)
          : await onboardingApi.registerPlayer(actor);
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const roles = [result.playerRoleId];
      const applicantRoleId =
        'companionApplicantRoleId' in result ? (result as CompanionApplicationResult).companionApplicantRoleId : null;
      if (applicantRoleId) roles.push(applicantRoleId);
      let rolePending = false;
      try {
        await member.roles.add(roles, 'Blackcat newcomer self-registration');
        await reconcileProductRoleTasks({ guild: interaction.guild, api: onboardingApi });
      } catch {
        rolePending = true;
      }
      const content = botCopy.onboarding.registrationResult({
        applicant: customId === APPLY_COMPANION_CUSTOM_ID,
        created: result.created,
        rolePending
      });
      await interaction.editReply({ content });
    } catch (error) {
      await interaction.editReply({
        content: formatUserFacingError(error, {
          operation: customId === APPLY_COMPANION_CUSTOM_ID ? '提交陪玩申请' : '注册客户账号',
          localRequestId: `discord-interaction-${interaction.id}`
        })
      });
    }
  }
}
