import { formatMinorCurrency } from './admin-business.js';
import type { BusinessTagGroups } from './business-tags.js';

export function OrderFact({ label, value, muted = false, strong = false }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return <div><dt>{label}</dt><dd className={`${muted ? 'is-muted' : ''}${strong ? ' is-strong' : ''}`.trim()} title={value}>{value}</dd></div>;
}

export function priceValue(amount: unknown, currency: unknown): string {
  return typeof amount === 'number' && typeof currency === 'string' ? formatMinorCurrency(amount, currency) : '由目录汇总';
}

export function playerStatusLabel(status: string): string {
  return ({ PENDING_REVIEW: '待审核', APPROVED: '已批准', REJECTED: '已拒绝', ACTIVE: '可接新单', PAUSED: '已暂停', SUSPENDED: '已停用', INACTIVE: '已停用' } as Record<string, string>)[status] ?? status;
}

export function catalogStatusLabel(status: string): string {
  return ({ DRAFT: '草稿', ACTIVE: '已启用', RETIRED: '已退役', INACTIVE: '已停用' } as Record<string, string>)[status] ?? status;
}

export function orderBillingSummary(item: Record<string, unknown>): string {
  const minutes = numberValue(item.billingUnitMinutes);
  const units = numberValue(item.unitCount);
  if (minutes && units) return `${units} 个计费单位 · 共 ${minutes * units} 分钟`;
  if (minutes) return `每单位 ${minutes} 分钟`;
  if (units) return `${units} 个计费单位`;
  return '';
}

export function orderPrice(item: Record<string, unknown>): string {
  return typeof item.amountMinor === 'number' && typeof item.currency === 'string'
    ? formatMinorCurrency(item.amountMinor, item.currency)
    : '待确认';
}

export function compactIdentifier(value: unknown): string {
  const id = textValue(value);
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id || '—';
}

export function formatOrderDate(value: unknown): string {
  if (typeof value !== 'string') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function orderStatusLabel(status: string): string {
  return ({ DRAFT: '草稿', PENDING_DISPATCH: '等待陪玩报名', ACCEPTED: '已接单', IN_SERVICE: '服务中', PENDING_CONFIRMATION: '等待客户确认', COMPLETED: '已完成', CANCELLED: '已取消', EXCEPTION: '需要处理' } as Record<string, string>)[status] ?? (status || '未知状态');
}

export function orderOperationalState(status:string):{blocker:string;nextAction:string}{
  return ({
    DRAFT:{blocker:'订单尚未提交',nextAction:'核对项目与价格后提交订单'},
    PENDING_DISPATCH:{blocker:'尚无陪玩接单',nextAction:'继续等待候选或联系客户'},
    ACCEPTED:{blocker:'等待所有有效陪玩就绪',nextAction:'确认各有效陪玩已完成就绪'},
    IN_SERVICE:{blocker:'无',nextAction:'关注服务进度与异常反馈'},
    PENDING_CONFIRMATION:{blocker:'等待客户确认完成',nextAction:'提醒客户确认或登记问题'},
    COMPLETED:{blocker:'无',nextAction:'无需处理'},
    CANCELLED:{blocker:'订单已取消',nextAction:'核对预留资金已释放'},
    EXCEPTION:{blocker:'订单存在异常',nextAction:'查看时间线并处理异常'}
  } as Record<string,{blocker:string;nextAction:string}>)[status]??{blocker:'状态待核对',nextAction:'查看详情并确认订单状态'};
}

export function formatRelativeDate(value:unknown):string{
  if(typeof value!=='string')return '未知时间';const timestamp=new Date(value).getTime();if(Number.isNaN(timestamp))return value;
  const seconds=Math.round((timestamp-Date.now())/1000);const absolute=Math.abs(seconds);
  const [amount,unit]:[number,Intl.RelativeTimeFormatUnit]=absolute<60?[seconds,'second']:absolute<3600?[Math.round(seconds/60),'minute']:absolute<86400?[Math.round(seconds/3600),'hour']:[Math.round(seconds/86400),'day'];
  return new Intl.RelativeTimeFormat('zh-CN',{numeric:'auto'}).format(amount,unit);
}

export function textValue(value:unknown):string{return typeof value==='string'?value:'';}
export function numberValue(value:unknown):number|undefined{return typeof value==='number'&&Number.isFinite(value)?value:undefined;}
export function scalarValue(value:unknown):string{return typeof value==='string'&&value?value:typeof value==='number'&&Number.isFinite(value)?String(value):'—';}

export function displayValue(column: string, value: unknown, currency: unknown, tags?: BusinessTagGroups): string {
  if (column.endsWith('Minor') && typeof value === 'number' && typeof currency === 'string') return formatMinorCurrency(value, currency);
  if (column === 'status' && typeof value === 'string') return orderStatusLabel(value);
  if (value === null || value === undefined) return '-';
  const tagType = column === 'gameTags' ? 'GAME' : column === 'serviceTags' ? 'SERVICE' : column === 'languageTags' ? 'LANGUAGE' : null;
  if (tagType && Array.isArray(value)) {
    const names = new Map((tags?.[tagType] ?? []).map((tag) => [tag.code, tag.displayName]));
    return value.map((code) => names.get(String(code)) ?? String(code)).join(', ');
  }
  if (Array.isArray(value)) return value.map((item) => typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
