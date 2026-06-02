import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { ButtonInteraction, Interaction } from 'discord.js';
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
      const content=customId===APPLY_COMPANION_CUSTOM_ID
        ? `陪玩申请已提交，当前状态：待审核。${rolePending?'账户已创建，Discord 角色正在同步。':'你仍可继续以玩家身份使用平台。'}`
        : `${result.created?'玩家账户和猫条钱包已创建。':'你已经注册过玩家账户。'}${rolePending?' Discord 角色正在同步。':' 已授予玩家角色。'}`;
      await interaction.editReply({content});
    }catch(error){const requestId=error instanceof OnboardingApiError?error.requestId:'local-onboarding-failed';await interaction.editReply({content:`暂时无法完成操作，请稍后重试。request_id: ${requestId}`});}
  }
}
