import { describe, expect, test } from 'vitest';
import { buildBotConfigChange, buildBotConfigNavigation } from '../apps/dashboard/src/bot-config-dashboard.js';

describe('M15-US-04 Bot configuration Dashboard',()=>{
  test('shows configuration only to staff with bot_config.read',()=>{
    expect(buildBotConfigNavigation(['bot_config.read'])).toEqual({id:'botConfig',label:'Bot 配置',href:'/bot-config'});
    expect(buildBotConfigNavigation(['dashboard.view'])).toBeNull();
  });
  test('builds one-field validated changes with typed values',()=>{
    expect(buildBotConfigChange('dispatch_timeout_minutes','15')).toEqual({dispatch_timeout_minutes:15});
    expect(buildBotConfigChange('new_orders_enabled','false')).toEqual({new_orders_enabled:false});
    expect(buildBotConfigChange('dispatch_channel_id','123456789012345678')).toEqual({dispatch_channel_id:'123456789012345678'});
  });
});
