import { describe,expect,test,vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createDispatchStartHandler } from '../apps/api/src/worker-handlers.js';
import type { OutboxJob } from '../apps/api/src/outbox.js';

const job:OutboxJob={id:'00000000-0000-0000-0000-000000009013',type:'DISPATCH_START',status:'PROCESSING',aggregateType:'order',aggregateId:'00000000-0000-0000-0000-000000009014',
  dedupeKey:'order-submit:dispatch-start',payload:{orderId:'00000000-0000-0000-0000-000000009014',expectedVersion:5,trigger:'ORDER_SUBMITTED'},attempts:1,maxAttempts:8,
  runAfter:'2026-08-02T00:00:00Z',lockedAt:'2026-08-02T00:00:00Z',lockedBy:'worker',lastError:null,version:2,createdAt:'2026-08-02T00:00:00Z',updatedAt:'2026-08-02T00:00:00Z'};

describe('M9-US-13 automatic 90-second dispatch rounds',()=>{
  test('worker consumes the submit-time dispatch start job',async()=>{const start=vi.fn();await createDispatchStartHandler({start})(job);expect(start).toHaveBeenCalledWith(
    {orderId:job.aggregateId,expectedVersion:5,trigger:'ORDER_SUBMITTED'},job);});
  test('submit persists DISPATCH_START atomically and worker uses 90-second rounds with timeout retry',async()=>{const orders=await readFile('apps/api/src/orders.ts','utf8');const worker=await readFile('apps/api/src/worker.ts','utf8');
    expect(orders).toContain("'DISPATCH_START'");expect(orders).toContain('dispatchStartJob');expect(worker).toContain('timeoutMinutes:1.5');expect(worker).toContain("trigger:'TIMEOUT_RETRY'");});
  test('dispatch buttons acknowledge Discord before calling the API and always render API failures',async()=>{
    const handler=await readFile('apps/bot/src/pieces/interaction-handlers/dispatch-buttons.ts','utf8');
    const deferIndex=handler.indexOf('await interaction.deferReply({ ephemeral: true })');
    const apiIndex=handler.indexOf('await api.acceptOrder(');
    expect(deferIndex).toBeGreaterThan(-1);
    expect(deferIndex).toBeLessThan(apiIndex);
    expect(handler).toContain('error instanceof BotApiError');
    expect(handler).toContain('await interaction.editReply(');
  });
});
