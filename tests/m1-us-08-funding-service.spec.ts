import { describe, expect, test } from 'vitest';
import { buildFundReservationDraft, resolveFundReservationMode } from '@blackcat/api/funding';

describe('M1-US-08 internal reservation helper',()=>{
  test('always uses the single local USD reservation backend',async()=>{
    await expect(resolveFundReservationMode({})).resolves.toBe('LOCAL_RESERVATION');
    const draft=buildFundReservationDraft({businessSource:{type:'ORDER',referenceId:'00000000-0000-0000-0000-000000001801'},
      userId:'00000000-0000-0000-0000-000000001802',provider:null,mode:'LOCAL_RESERVATION',amountMinor:100,currency:'USD',
      idempotencyKey:'m1:08:reserve:internal',ttlMinutes:30,now:new Date('2026-07-21T18:00:00Z')});
    expect(draft).toMatchObject({mode:'LOCAL_RESERVATION',provider:null,currency:'USD',status:'PENDING'});
  });
});
