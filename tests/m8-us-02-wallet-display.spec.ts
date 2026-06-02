import { describe,expect,test } from 'vitest';
import { DEFAULT_WALLET_DISPLAY_CONFIG,customerWalletLabel,formatCustomerWalletAmount,parseWalletDisplayConfig } from '@blackcat/bot/wallet-display';

describe('M8-US-02 fixed CAT display',()=>{
  test('uses an immutable 猫条/CAT configuration',()=>{
    expect(DEFAULT_WALLET_DISPLAY_CONFIG).toEqual({displayName:'猫条',symbol:'CAT',subunitsPerCat:10});
    expect(parseWalletDisplayConfig({})).toEqual(DEFAULT_WALLET_DISPLAY_CONFIG);
    expect(customerWalletLabel()).toBe('猫条钱包');
    expect(()=>parseWalletDisplayConfig({WALLET_DISPLAY_NAME:'星币'})).toThrow(/fixed/u);
    expect(()=>parseWalletDisplayConfig({WALLET_DISPLAY_SYMBOL:'SC'})).toThrow(/fixed/u);
  });

  test('formats integer CAT subunits with one decimal place',()=>{
    expect(formatCustomerWalletAmount(0)).toBe('0.0 CAT');
    expect(formatCustomerWalletAmount(1)).toBe('0.1 CAT');
    expect(formatCustomerWalletAmount(10)).toBe('1.0 CAT');
    expect(formatCustomerWalletAmount(10_000)).toBe('1,000.0 CAT');
    expect(formatCustomerWalletAmount(-1)).toBe('-0.1 CAT');
    for(const invalid of [Number.NaN,Number.POSITIVE_INFINITY,0.1,Number.MAX_SAFE_INTEGER+1])expect(()=>formatCustomerWalletAmount(invalid)).toThrow('amountMinor');
  });
});
