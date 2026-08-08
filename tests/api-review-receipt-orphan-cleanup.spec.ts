import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { buildApiServer } from '@blackcat/api/server';
import { PrivateFileReceiptStorage } from '@blackcat/api/receipt-storage';
import { InMemoryAuditSink, InMemoryIdempotencyStore, type StaffAccount } from '@blackcat/api/security';
import { WalletError, type ReceiptAttachmentMetadata, type WalletApplicationService } from '@blackcat/api/wallet';

const userId='00000000-0000-0000-0000-000000022001';
const guildId='900000000000022001';
const evidenceId='00000000-0000-0000-0000-000000022002';
const attachmentId='00000000-0000-0000-0000-000000022003';
const staff:StaffAccount={staffId:'00000000-0000-0000-0000-000000022004',userId:'00000000-0000-0000-0000-000000022005',level:'L2_SUPERVISOR',permissionsVersion:1,status:'ACTIVE'};
const env={NODE_ENV:'test',DATABASE_URL:'',API_PORT:'0',API_BASE_URL:'http://localhost:3000',BOT_SERVICE_TOKEN:'receipt-cleanup-token',PAGINATION_CURSOR_SIGNING_SECRET:'receipt-cleanup-signing-secret-32-bytes'};
const dashboardSessions={resolve:()=>({ok:true as const,staff,csrfToken:'csrf'}),verifyCsrf:()=>true};
const headers={cookie:'p0_session=session; p0_csrf=csrf','x-csrf-token':'csrf','x-client-source':'DASHBOARD','idempotency-key':'receipt:cleanup:0001'};
const roots:string[]=[];

afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});

describe('API review receipt orphan cleanup',()=>{
  test('private storage removal is idempotent and makes staged bytes unreachable',async()=>{
    const {root,storage}=await receiptStorage();
    const stored=await storage.put({body:bytes('%PDF staged'),mediaType:'application/pdf',originalFileName:'receipt.pdf'});
    await storage.remove(stored.storageKey);
    await expect(storage.remove(stored.storageKey)).resolves.toBeUndefined();
    await expect(storage.open(stored.storageKey)).rejects.toThrow();
    expect(await readdir(root)).toEqual([]);
  });

  test.each([
    ['invalid multipart evidence','not-a-uuid',async()=>{throw new Error('service must not run');},400],
    ['missing funding evidence',evidenceId,async()=>{throw new WalletError('RESOURCE_NOT_FOUND','Funding evidence was not found.');},404],
    ['transactional commit failure',evidenceId,async()=>stagedReceipt(async()=>{throw new Error('database commit failed');}),500]
  ] as const)('removes staged bytes after %s',async(_name,formEvidenceId,stage,statusCode)=>{
    const {root,storage}=await receiptStorage();
    const service={stageCreateReceiptAttachment:stage} as unknown as WalletApplicationService;
    const server=buildApiServer({env,security:{dashboardSessions,dashboardGuildId:guildId,auditSink:new InMemoryAuditSink(),idempotencyStore:new InMemoryIdempotencyStore()},
      wallet:{service,customerScope:{canReadCustomer:()=>true},receiptStorage:storage}});
    const response=await server.inject({method:'POST',url:`/api/v1/admin/users/${userId}/receipt-attachments`,headers:{...headers,'content-type':`multipart/form-data; boundary=${boundary}`},payload:multipart(formEvidenceId)});
    expect(response.statusCode,response.body).toBe(statusCode);
    expect(await readdir(root)).toEqual([]);
  });
});

const boundary='----receiptcleanupboundary';
function multipart(id:string){return Buffer.from([
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="receipt.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF private receipt\r\n`,
  `--${boundary}\r\nContent-Disposition: form-data; name="evidenceType"\r\n\r\nTOP_UP\r\n`,
  `--${boundary}\r\nContent-Disposition: form-data; name="evidenceId"\r\n\r\n${id}\r\n`,
  `--${boundary}--\r\n`
].join(''));}
function bytes(value:string){return(async function*(){yield Buffer.from(value);})();}
async function receiptStorage(){const root=await mkdtemp(join(tmpdir(),'api-review-receipt-cleanup-'));roots.push(root);return{root,storage:new PrivateFileReceiptStorage(root)};}
function stagedReceipt(commit:()=>Promise<void>){const data:ReceiptAttachmentMetadata={id:attachmentId,mediaType:'application/pdf',originalFileName:'receipt.pdf',byteSize:20,sha256:'a'.repeat(64),uploadedAt:'2026-08-13T08:00:00.000Z'};return{data,commit};}
