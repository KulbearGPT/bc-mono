import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe,expect,test } from 'vitest';
import { CustomerWalletPanel } from '../apps/dashboard/src/CustomerWalletPanel.js';
import { buildWalletRequest,formatWalletMoney } from '@blackcat/dashboard/customer-wallet';

describe('M7-US-06 Dashboard wallet',()=>{
  test('renders required funding evidence and optional receipt',()=>{
    const html=renderToStaticMarkup(createElement(CustomerWalletPanel,{userId:'00000000-0000-0000-0000-000000007601',
      balance:{ledgerBalanceMinor:500_000,reservedMinor:0,availableMinor:500_000,currency:'CAT',calculatedAt:'2026-07-21T18:00:00Z',version:2},entries:[],busy:false,
      canTopUp:true,canExternalRefund:true,onTopUp:()=>undefined,onExternalRefund:()=>undefined}));
    for(const label of ['支付方式','收据号 / 渠道交易号','付款时间','备注','原因代码'])expect(html).toMatch(new RegExp(`<label[^>]*>[^<]*${label}`,'u'));
    expect(html).toContain('required=""');
    expect(html).toContain('Receipt 图片或 PDF（可选）');
    expect(html).toContain('50,000.0 猫条');
  });
  test('builds wallet endpoints and never sends attachment IDs with the funding fact',()=>{
    const request=buildWalletRequest('TOP_UP','user/1',{amountMinor:100,paymentChannel:'ZELLE',externalTransactionId:'pi_1',occurredAt:'2026-07-21T18:00:00Z',note:'verified',reasonCode:'MANUAL_TOP_UP'});
    expect(request).toEqual({method:'POST',path:'/api/v1/admin/users/user%2F1/top-ups',body:{paidAmountUsdCents:100,paidCurrency:'USD',paymentMethod:'ZELLE',receiptNumber:'pi_1',paidAt:'2026-07-21T18:00:00Z',note:'verified',reasonCode:'MANUAL_TOP_UP'}});
    expect(JSON.stringify(request)).not.toContain('attachmentIds');
    expect(formatWalletMoney(500_000)).toBe('50,000.0 猫条');
  });
});
