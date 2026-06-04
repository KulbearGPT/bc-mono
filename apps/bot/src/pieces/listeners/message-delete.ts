import { Events,Listener } from '@sapphire/framework';
import type { Message,PartialMessage } from 'discord.js';
import { orderChannelTranscriptApi } from '../../order-channel-transcript.js';
export default class MessageDeleteListener extends Listener<typeof Events.MessageDelete>{public constructor(context:Listener.LoaderContext){super(context,{event:Events.MessageDelete});}public async run(message:Message|PartialMessage){try{await orderChannelTranscriptApi.record(message,'DELETED');}catch(error){this.container.logger.error({event:'bot.transcript.delete_failed',guildId:message.guildId,channelId:message.channelId,messageId:message.id,error});}}}
