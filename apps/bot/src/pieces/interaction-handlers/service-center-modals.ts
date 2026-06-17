import { InteractionHandler, InteractionHandlerTypes } from '@sapphire/framework';
import type { Interaction } from 'discord.js';
import { HttpBotApiClient,buildDiscordIdempotencyKey,handleOrderNotesSubmit,handleRequirementNoteSubmit,parseServiceCenterCustomId, type BotActorContext,type ServiceCenterRoute } from '../../service-center.js';
import { toDiscordReply } from '../../discord-renderer.js';

export default class ServiceCenterModalHandler extends InteractionHandler {
  public constructor(context: InteractionHandler.LoaderContext) {
    super(context, { interactionHandlerType: InteractionHandlerTypes.ModalSubmit });
  }

  public override parse(interaction: Interaction) {
    if (!interaction.isModalSubmit()) {
      return this.none();
    }
    const route = parseServiceCenterCustomId(interaction.customId);
    return route.area === 'order-notes-modal'||route.area==='requirement-note-modal' ? this.some(route) : this.none();
  }

  public override async run(interaction: Interaction, parsedData?: ServiceCenterRoute): Promise<void> {
    if (!interaction.isModalSubmit()) {
      return;
    }

    if((parsedData?.area!=='order-notes-modal'&&parsedData?.area!=='requirement-note-modal')||!interaction.guildId)return;
    await interaction.deferUpdate();
    const actor:BotActorContext={guildId:interaction.guildId,discordUserId:interaction.user.id,interactionId:interaction.id,clientSource:'DISCORD_BOT'};
    const api=new HttpBotApiClient({apiBaseUrl:process.env.API_BASE_URL??'',botServiceToken:process.env.BOT_SERVICE_TOKEN??''});const result=parsedData.area==='requirement-note-modal'?await handleRequirementNoteSubmit({api,actor,orderId:parsedData.orderId,requirementId:parsedData.requirementId,expectedVersion:parsedData.expectedVersion,expectedRequirementVersion:parsedData.expectedRequirementVersion,customerNote:interaction.fields.getTextInputValue('requirement-note'),idempotencyKey:buildDiscordIdempotencyKey('requirement:note',interaction.id)}):await handleOrderNotesSubmit({api,actor,orderId:parsedData.orderId,expectedVersion:parsedData.expectedVersion,notes:interaction.fields.getTextInputValue('notes'),idempotencyKey:buildDiscordIdempotencyKey('order:notes',interaction.id)});
    if(result.kind==='EDIT_ORIGINAL_MESSAGE'){const reply=toDiscordReply(result.message);await interaction.editReply({content:null,embeds:reply.embeds,components:reply.components});return;}
    if(result.kind==='EPHEMERAL_MESSAGE')await interaction.followUp({content:result.message,ephemeral:true});
  }
}
