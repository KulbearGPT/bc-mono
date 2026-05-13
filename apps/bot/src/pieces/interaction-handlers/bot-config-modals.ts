import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { Interaction, ModalSubmitInteraction } from 'discord.js';
import { botConfigFlow, parseBotConfigCustomId, toDiscordBotConfigReply, type BotConfigActorContext } from '../../bot-config.js';

export default class BotConfigModalHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) { super(context,{interactionHandlerType:InteractionHandlerTypes.ModalSubmit}); }
  public override parse(interaction:Interaction){if(!interaction.isModalSubmit())return this.none();const route=parseBotConfigCustomId(interaction.customId);return route?.operation==='modal'?this.some(route):this.none();}
  public override async run(interaction:ModalSubmitInteraction,route:{operation:'modal';sessionId:string}){
    const actor=actorFrom(interaction);if(!actor){await interaction.reply({content:'请在服务器内管理 Bot 配置。',ephemeral:true});return;}
    await interaction.deferReply({ephemeral:true});
    try{const reply=toDiscordBotConfigReply(await botConfigFlow.previewTextInput(actor,route.sessionId,interaction.fields.getTextInputValue('value'),`discord:bot-config:validate:${interaction.id}`));await interaction.editReply({content:reply.content,components:reply.components});}
    catch(error){const requestId=typeof error==='object'&&error&&'requestId'in error?String(error.requestId):'local-bot-config';await interaction.editReply({content:`Bot 配置校验失败，请重新打开命令。request_id: ${requestId}`,components:[]});}
  }
}
function actorFrom(interaction:ModalSubmitInteraction):BotConfigActorContext|null{return interaction.guildId?{guildId:interaction.guildId,discordUserId:interaction.user.id,interactionId:interaction.id,clientSource:'DISCORD_BOT'}:null;}
