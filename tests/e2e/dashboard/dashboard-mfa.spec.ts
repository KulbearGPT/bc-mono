import { createHmac } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

function decodeBase32(value: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const character of value.toUpperCase().replace(/=+$/u, '')) bits += alphabet.indexOf(character).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function totp(secret: string): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(binary % 1_000_000).padStart(6, '0');
}

async function login(page: Page, actor: 'l4' | 'mfa') {
  await page.goto(`/__e2e/login/${actor}`);
  await page.waitForURL('**/');
  await page.getByRole('navigation', { name: '管理导航' }).getByRole('link', { name: '账户安全', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账户安全与操作范围' })).toBeVisible();
}

async function sensitiveWrite(page: Page, key: string) {
  return page.evaluate(async (idempotencyKey) => {
    const csrf = document.cookie.split('; ').find((entry) => entry.startsWith('p0_csrf='))?.split('=').slice(1).join('=') ?? '';
    const response = await fetch('/api/v1/admin/e2e-sensitive-action', {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-source': 'DASHBOARD', 'x-csrf-token': decodeURIComponent(csrf), 'idempotency-key': idempotencyKey }, body: '{}'
    });
    return { status: response.status, body: await response.json() };
  }, key);
}

test.describe('Dashboard browser E2E: MFA and step-up', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('http://127.0.0.1:3000/__e2e/reset');
  });

  test('DE2E-AUTH-008 sensitive writes return 428 until browser step-up succeeds', async ({ page, request }) => {
    await login(page, 'l4');
    const rejected = await sensitiveWrite(page, 'sensitive-before-step-up');
    expect(rejected.status).toBe(428);
    expect(rejected.body.error.code).toBe('STEP_UP_REQUIRED');

    await page.getByRole('button', { name: '进行近期验证' }).click();
    const proof = (await (await request.get('http://127.0.0.1:3000/__e2e/totp/l4')).json()).proof as string;
    await page.getByLabel('验证码或恢复码').fill(proof);
    await page.getByRole('button', { name: '使用验证码确认' }).click();
    await expect(page.locator('.status-message')).toContainText('近期验证有效至');

    const accepted = await sensitiveWrite(page, 'sensitive-after-step-up');
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toEqual({ executed: true });
  });

  test('DE2E-AUTH-009 an expired step-up blocks the next sensitive submission again', async ({ page, request }) => {
    await login(page, 'l4');
    await page.getByRole('button', { name: '进行近期验证' }).click();
    const proof = (await (await request.get('http://127.0.0.1:3000/__e2e/totp/l4')).json()).proof as string;
    await page.getByLabel('验证码或恢复码').fill(proof);
    await page.getByRole('button', { name: '使用验证码确认' }).click();
    await expect(page.locator('.status-message')).toContainText('近期验证有效至');
    expect((await sensitiveWrite(page, 'sensitive-before-expiry')).status).toBe(200);
    await request.post('http://127.0.0.1:3000/__e2e/advance-time', { data: { milliseconds: 16 * 60_000 } });
    const expired = await sensitiveWrite(page, 'sensitive-after-expiry');
    expect(expired.status).toBe(428);
    expect(expired.body.error.code).toBe('STEP_UP_REQUIRED');
    await page.reload();
    await expect(page.getByRole('button', { name: '进行近期验证' })).toBeVisible();
  });

  test('DE2E-MFA-001 enrollment rejects an incorrect proof then activates with the current TOTP', async ({ page }) => {
    await login(page, 'mfa');
    await page.getByRole('button', { name: '绑定验证器' }).click();
    const provisioning = await page.getByText(/otpauth:\/\/totp\//u).textContent();
    const uri = provisioning?.slice(provisioning.indexOf('otpauth://')) ?? '';
    const secret = new URL(uri).searchParams.get('secret');
    expect(secret).toBeTruthy();

    await page.getByLabel('验证码或恢复码').fill('000000');
    await page.getByRole('button', { name: '确认绑定' }).click();
    await expect(page.locator('.status-message')).toContainText(/invalid/iu);

    await page.getByLabel('验证码或恢复码').fill(totp(secret!));
    await page.getByRole('button', { name: '确认绑定' }).click();
    await expect(page.locator('.status-message')).toContainText('MFA 已启用');
    await expect(page.getByRole('heading', { name: '一次性恢复码' })).toBeVisible();
  });
});
