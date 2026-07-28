import { describe, expect, test } from 'vitest';
import { buildSelectionReactionOfferPayload, resolveSelectionGameBanner } from '@blackcat/api/selection-pool-worker';

const poolId = '00000000-0000-0000-0000-000000180501';

describe('M18-US-05 dispatch and trial-matching experience', () => {
  test('maps a single game to its original Blackcat banner and mixed games to the safe fallback', () => {
    expect(resolveSelectionGameBanner(['无畏契约 · 娱乐陪玩'])).toMatchObject({
      fileName: 'valorant.webp',
      attachmentName: 'blackcat-game-valorant.webp'
    });
    expect(resolveSelectionGameBanner(['英雄联盟 · 上分陪玩', '无畏契约 · 娱乐陪玩'])).toMatchObject({
      fileName: 'other.webp',
      attachmentName: 'blackcat-game-other.webp'
    });
    expect(resolveSelectionGameBanner(['../../private/token'])).toMatchObject({ fileName: 'other.webp' });
  });

  test('renders a branded reaction-only recruitment card with clear add/remove semantics', () => {
    const payload = buildSelectionReactionOfferPayload({
      poolId,
      orderPublicId: 'P-M18-DISPATCH',
      requirements: [
        {
          id: '00000000-0000-0000-0000-000000180502',
          label: '无畏契约 · 娱乐陪玩',
          remainingSlots: 1,
          expectedEarningMinor: 188,
          currency: 'CAT',
          customerNote: '声音温柔，轻松聊天就好'
        }
      ]
    });
    const embed = payload.embeds[0]!;
    const rendered = JSON.stringify(payload);

    expect(embed.title).toBe('🐾 新单报名 #P-M18-DISPATCH');
    expect(embed.color).toBe(0x6d5dfc);
    expect(embed.description).toContain('添加对应数字 = 报名');
    expect(embed.description).toContain('移除对应数字 = 取消报名');
    expect(rendered).not.toContain('预计收益');
    expect(rendered).not.toContain('18.8 CAT');
    expect(embed.fields[0]?.value).toContain('需求：声音温柔');
    expect(embed.image).toEqual({ url: 'attachment://blackcat-game-valorant.webp' });
    expect(embed.footer).toEqual({ text: `selection-pool:${poolId}` });
    expect(payload.components).toEqual([]);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(rendered).not.toMatch(/候选|选拔|选秀/u);
  });

  test('keeps one stable 1–9 reaction mapping and rejects a tenth project', () => {
    const requirements = Array.from({ length: 9 }, (_, index) => ({
      id: `00000000-0000-0000-0000-${String(180510 + index).padStart(12, '0')}`,
      label: `项目 ${index + 1}`,
      remainingSlots: 1,
      expectedEarningMinor: 100,
      currency: 'CAT'
    }));
    const payload = buildSelectionReactionOfferPayload({ poolId, orderPublicId: 'P-NINE', requirements });
    expect(payload.embeds[0]?.fields.map((field) => field.name.slice(0, 3))).toEqual([
      '1️⃣',
      '2️⃣',
      '3️⃣',
      '4️⃣',
      '5️⃣',
      '6️⃣',
      '7️⃣',
      '8️⃣',
      '9️⃣'
    ]);
    expect(() =>
      buildSelectionReactionOfferPayload({
        poolId,
        orderPublicId: 'P-TEN',
        requirements: [...requirements, { ...requirements[0]!, id: '00000000-0000-0000-0000-000000180599' }]
      })
    ).toThrow(/at most 9/u);
  });
});
