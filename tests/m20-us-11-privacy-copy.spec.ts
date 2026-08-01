import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { buildOnboardingMessage } from '@blackcat/bot/onboarding';
import { toDiscordReply, toDiscordUpdate } from '../apps/bot/src/discord-renderer.js';
import type { MessageSpec } from '../apps/bot/src/service-center-components.js';

const injectedMessage: MessageSpec = {
  title: '展示名 <@111111111111111111>',
  body: '备注 @everyone <@&222222222222222222>',
  visibility: 'PUBLIC',
  components: []
};

describe('M20-US-11 Discord privacy and current copy', () => {
  test('disables all mention parsing for replies and updates by default', () => {
    expect(toDiscordReply(injectedMessage).allowedMentions).toEqual({ parse: [] });
    expect(toDiscordUpdate(injectedMessage).allowedMentions).toEqual({ parse: [] });
    expect(toDiscordReply({ ...injectedMessage, layout: 'COMPONENTS_V2' }).allowedMentions).toEqual({ parse: [] });
    expect(toDiscordUpdate({ ...injectedMessage, layout: 'COMPONENTS_V2' }).allowedMentions).toEqual({ parse: [] });
  });

  test('keeps exactly one primary action on the onboarding row', () => {
    const row = buildOnboardingMessage().components?.[0]?.toJSON();
    expect(row?.components.filter((component) => component.style === 1)).toHaveLength(1);
    expect(row?.components.find((component) => component.style === 1)?.label).toBe('🎮 开始找陪玩');
  });

  test('removes retired deadline wording and the incorrect USD gift invariant', async () => {
    const sources = await Promise.all(
      [
        'apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts',
        'apps/bot/src/pieces/interaction-handlers/selection-selects.ts',
        'apps/bot/src/gifts.ts'
      ].map((path) => readFile(path, 'utf8'))
    );
    expect(sources.join('\n')).not.toContain('截止前撤回');
    expect(sources[2]).toContain('canonical CAT subunits');
    expect(sources[2]).not.toContain('canonical USD minor units');
  });
});
