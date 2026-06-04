import { Events,Listener } from '@sapphire/framework';
import type { Message,PartialMessage } from 'discord.js';
import { orderChannelTranscriptApi } from '../../order-channel-transcript.js';
export default class MessageUpdateListener extends Listener<typeof Events.MessageUpdate>{public constructor(context:Listener.LoaderContext){super(context,{event:Events.MessageUpdate});}public async run(_old:Message|PartialMessage,message:Message|PartialMessage){try{await orderChannelTranscriptApi.record(message,'UPDATED');}catch(error){this.container.logger.error({event:'bot.transcript.update_failed',guildId:message.guildId,channelId:message.channelId,messageId:message.id,error});}}}
