export function formatMinorCurrency(amountMinor: number, currency: string, locale = 'zh-CN'): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new TypeError('金额格式无效。');
  }
  if(currency==='CAT')return `${(amountMinor/10).toLocaleString(locale,{minimumFractionDigits:1,maximumFractionDigits:1})} 猫条`;
  const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'code' });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(amountMinor / (10 ** fractionDigits));
}

export function catInputToMinor(value: unknown, options: { allowZero?: boolean; field?: string } = {}): number {
  const field = options.field ?? '金额';
  const normalized = (typeof value === 'string' || typeof value === 'number') ? String(value).trim() : '';
  if (!/^\d+(?:\.\d)?$/u.test(normalized)) throw new TypeError(`${field}必须以猫条填写，最多保留一位小数。`);
  const [whole, decimal = '0'] = normalized.split('.');
  const amountMinor = Number(whole) * 10 + Number(decimal);
  const minimum = options.allowZero ? 0 : 1;
  if (!Number.isSafeInteger(amountMinor) || amountMinor < minimum) {
    throw new TypeError(options.allowZero ? `${field}不能小于 0 猫条。` : `${field}必须大于 0 猫条。`);
  }
  return amountMinor;
}

export function minorToCatInput(amountMinor: unknown): string {
  if (!Number.isSafeInteger(amountMinor) || Number(amountMinor) < 0) throw new TypeError('金额格式无效。');
  const value = Number(amountMinor);
  const whole = Math.floor(value / 10);
  const decimal = value % 10;
  return decimal === 0 ? String(whole) : `${whole}.${decimal}`;
}
