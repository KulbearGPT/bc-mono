import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('M12-US-03 Dashboard refresh projection',()=>{
  test('renders API response facts without implementing a client-side SLA or realtime promise',()=>{
    const source=readFileSync('apps/dashboard/src/SupportWorkbenchPage.tsx','utf8');
    expect(source).toContain("task.responseStatus==='PENDING'");
    expect(source).toContain("task.responseStatus==='OVERDUE'");
    expect(source).toContain("task.responseStatus==='MET'");
    expect(source).toContain('/api/v1/admin/staff-tasks');
    expect(source).not.toMatch(/WebSocket|EventSource|setInterval\([^)]*responseDueAt/u);
  });
});
