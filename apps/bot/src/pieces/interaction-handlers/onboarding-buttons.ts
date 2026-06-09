import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction, Interaction } from 'discord.js';
import { botCopy } from '../../bot-copy.js';
import { APPLY_COMPANION_CUSTOM_ID, OnboardingApiError, REGISTER_PLAYER_CUSTOM_ID, onboardingApi, reconcileProductRoleTasks, type CompanionApplicationResult } from '../../onboarding.js';

export default class OnboardingButtonHandler extends InteractionHandler {
  public constructor(context:InteractionHandler.LoaderContext){super(context,{interactionHandlerType:InteractionHandlerTypes.Button});}
  public override parse(interaction:Interaction){return interaction.isButton()&&(interaction.customId===REGISTER_PLAYER_CUSTOM_ID||interaction.customId===APPLY_COMPANION_CUSTOM_ID)?this.some(interaction.customId):this.none();}
  public override async run(interaction:Interaction,customId?:string):Promise<void>{if(!interaction.isButton()||!interaction.inGuild()||!interaction.guild||!customId)return;
    await interaction.deferReply({ephemeral:true});const actor={guildId:interaction.guildId,discordUserId:interaction.user.id,interactionId:interaction.id,
      displayName:interaction.member&&'displayName'in interaction.member?String(interaction.member.displayName):interaction.user.globalName??interaction.user.username};
    try{const result=customId===APPLY_COMPANION_CUSTOM_ID?await onboardingApi.applyForCompanion(actor):await onboardingApi.registerPlayer(actor);
      const member=await interaction.guild.members.fetch(interaction.user.id);const roles=[result.playerRoleId];const applicantRoleId='companionApplicantRoleId'in result?(result as CompanionApplicationResult).companionApplicantRoleId:null;if(applicantRoleId)roles.push(applicantRoleId);
      let rolePending=false;try{await member.roles.add(roles,'Blackcat newcomer self-registration');await reconcileProductRoleTasks({guild:interaction.guild,api:onboardingApi});}catch{rolePending=true;}
      const content=botCopy.onboarding.registrationResult({applicant:customId===APPLY_COMPANION_CUSTOM_ID,created:result.created,rolePending});
      await interaction.editReply({content});
    }catch(error){const requestId=error instanceof OnboardingApiError?error.requestId:'local-onboarding-failed';await interaction.editReply({content:botCopy.common.retryWithRequestId(requestId)});}
  }
}
