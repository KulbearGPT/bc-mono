import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

describe('M22-US-03 real Guild recovery UAT harness', () => {
  test('is SANDBOX-only, isolated, self-cleaning, and leaves human interaction pending', async () => {
    const [script, runbook] = await Promise.all([
      readFile('scripts/uat/m22-gift-entry-uat.ts', 'utf8'),
      readFile('evidence/P0/M22-US-03/human-uat-runbook.md', 'utf8')
    ]);

    expect(script).toContain("process.env.BUSINESS_ENV !== 'SANDBOX'");
    expect(script).toContain("M22_UAT_CONFIRM !== 'DELETE_TEMP_GIFT_CHANNEL'");
    expect(script).toContain('PostgresOnboardingStore');
    expect(script).toContain('HttpOnboardingApiClient');
    expect(script).toContain('ensureStandaloneGiftEntryMessage');
    expect(script).toContain("temporaryDatabase: 'DELETED'");
    expect(script).toContain("temporaryDiscordChannel: 'DELETED'");
    expect(script).toContain("humanDesktopMobileInteraction: 'PENDING'");
    expect(script).toContain('apiBusinessMutationCalls: 0');
    expect(script).toContain("status: 'PASS_AUTOMATED_PROBE'");
    expect(runbook).toContain('状态：`PENDING_EXTERNAL`');
    expect(runbook).toContain('桌面端');
    expect(runbook).toContain('手机端');
    expect(runbook).toContain('不得由 Codex、Bot 或自动探针代签');
  });
});
