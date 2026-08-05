import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { DashboardOverlay } from './DashboardOverlay.js';
import { formatMinorCurrency, minorToCatInput, type AdminBusinessAction } from './admin-business.js';
import type { BusinessTagGroups, BusinessTagRecord } from './business-tags.js';
import { numberValue, textValue } from './admin-business-presenters.js';

export function AdminBusinessActionPanel(props: {
  active: { action: AdminBusinessAction; item?: Record<string, unknown> };
  status: 'IDLE' | 'SUBMITTING' | 'ERROR';
  error?: string | null;
  onCancel?: () => void;
  onSubmit?: (action: AdminBusinessAction, item: Record<string, unknown> | undefined, fields: Record<string, string | boolean>) => void;
  businessTagOptions?: BusinessTagGroups;
  serviceCatalogOptions?: Array<Record<string, unknown>>;
}) {
  const action = props.active.action;
  const [pendingCompensation,setPendingCompensation]=useState<{fields:Record<string,string|boolean>;changes:Array<{offering:Record<string,unknown>;draft:Record<string,string>}>}|null>(null);
  const handleSubmit=(event:FormEvent<HTMLFormElement>)=>{event.preventDefault();const fields=collectActionFields(event.currentTarget);if(action.id==='EDIT_PLAYER_COMPENSATION'&&typeof fields.compensationChangesJson==='string'){try{const drafts=JSON.parse(fields.compensationChangesJson) as Array<Record<string,string>>;const changes=drafts.map((draft)=>({draft,offering:(props.serviceCatalogOptions??[]).find((item)=>textValue(item.serviceOfferingId)===draft.serviceOfferingId)})).filter((change):change is {offering:Record<string,unknown>;draft:Record<string,string>}=>Boolean(change.offering));if(changes.length){setPendingCompensation({fields,changes});return;}}catch{/* API builder will report malformed drafts. */}}props.onSubmit?.(action,props.active.item,fields);};
  return <>
    <aside className="action-panel" aria-label={`${action.label}操作面板`}>
      <div className="panel-heading"><div><span className="page-eyebrow">ACTION</span><h2>{action.label}</h2></div><button type="button" disabled={props.status === 'SUBMITTING'} onClick={props.onCancel}>关闭</button></div>
      <form className="form-grid" aria-label={`${action.label}操作表单`} onSubmit={handleSubmit}>
        <ActionFields action={action} item={props.active.item} businessTagOptions={props.businessTagOptions} serviceCatalogOptions={props.serviceCatalogOptions} />
        {action.requiresReason && (action.id === 'CANCEL_ORDER_RESOLUTION'
          ? <label className="field"><span>取消原因</span><select name="reasonCode" required defaultValue="USER_REQUEST"><option value="USER_REQUEST">客户请求</option><option value="DISPATCH_TIMEOUT">派单超时</option><option value="PLAYER_NO_SHOW">陪玩未到场</option><option value="CUSTOMER_NO_SHOW">客户未到场</option><option value="SERVICE_INTERRUPTED">服务中断</option><option value="COMPLETION_DISPUTE">完成争议</option><option value="PAYMENT_FAILURE">资金处理失败</option><option value="REFUND_FAILURE">退款处理失败</option><option value="ADMIN_CORRECTION">管理员纠正</option></select></label>
          : action.id === 'REFUND_ORDER' ? null
          : <label className="field"><span>原因码</span><input name="reasonCode" required pattern="[A-Z0-9_]{3,100}" placeholder="OPERATIONS_DECISION" /></label>)}
        {props.error && <p className="form-message form-message--error" role="alert">{props.error}</p>}
        <div className="form-actions">
          <button className="button-primary" type="submit" disabled={props.status === 'SUBMITTING'}>{props.status === 'SUBMITTING' ? '提交中...' : '提交'}</button>
          <button type="button" disabled={props.status === 'SUBMITTING'} onClick={props.onCancel}>取消</button>
        </div>
      </form>
    </aside>
    {pendingCompensation&&<DashboardOverlay label="确认项目分成改动" onClose={()=>setPendingCompensation(null)}><CompensationChangeConfirmation changes={pendingCompensation.changes} onCancel={()=>setPendingCompensation(null)} onConfirm={()=>{const pending=pendingCompensation;setPendingCompensation(null);props.onSubmit?.(action,props.active.item,pending.fields);}}/></DashboardOverlay>}
  </>;
}

function CompensationChangeConfirmation(props:{changes:Array<{offering:Record<string,unknown>;draft:Record<string,string>}>;onCancel:()=>void;onConfirm:()=>void}){return <aside className="action-panel compensation-confirmation" aria-label="分成改动确认"><div className="panel-heading"><div><span className="page-eyebrow">CONFIRM CHANGE</span><h2>确认分成改动（{props.changes.length} 项）</h2></div><button type="button" onClick={props.onCancel}>返回编辑</button></div><p>确认后会一次性写入全部项目；任一项目版本冲突或校验失败时，所有改动都不会保存。</p><div className="compensation-confirmation__changes">{props.changes.map(({offering,draft})=>{const rule=offering.compensationRule as Record<string,unknown>|undefined;return <dl className="compensation-confirmation__facts" key={draft.serviceOfferingId}><div><dt>项目</dt><dd>{compensationProjectName(offering)}</dd></div><div><dt>原分成</dt><dd>{compensationRuleText(rule,offering)}</dd></div><div><dt>新分成</dt><dd>{compensationDraftText(draft)}</dd></div><div><dt>修改方式</dt><dd>{draft.type==='FIXED_MINOR'?'每计费单位固定收益':'按客户价格比例'}</dd></div></dl>;})}</div><div className="form-actions"><button className="button-primary" type="button" onClick={props.onConfirm}>确认并保存全部</button><button type="button" onClick={props.onCancel}>取消</button></div></aside>}

function ActionFields({ action, item, businessTagOptions, serviceCatalogOptions }: { action: AdminBusinessAction; item?:Record<string,unknown>; businessTagOptions?: BusinessTagGroups;serviceCatalogOptions?:Array<Record<string,unknown>> }) {
  if(action.id==='REFUND_ORDER')return <StandaloneRefundFields item={item}/>;
  if(action.id==='CANCEL_ORDER_RESOLUTION')return <OrderCancellationResolutionFields item={item}/>;
  if(action.id==='APPROVE_COMPANION')return <><TagSelect name="gameTagIds" label="支持游戏" items={businessTagOptions?.GAME??[]} multiple/><TagSelect name="serviceTagIds" label="支持服务/种类" items={businessTagOptions?.SERVICE??[]} multiple/><TagSelect name="languageTagIds" label="服务语言（可选）" items={businessTagOptions?.LANGUAGE??[]} multiple required={false}/></>;
  if(action.id==='EDIT_COMPANION_TAGS')return <><TagSelect name="gameTagIds" label="支持游戏" items={businessTagOptions?.GAME??[]} multiple selectedCodes={stringList(item?.gameTags)}/><TagSelect name="serviceTagIds" label="支持服务/种类" items={businessTagOptions?.SERVICE??[]} multiple selectedCodes={stringList(item?.serviceTags)}/><TagSelect name="languageTagIds" label="服务语言（可选）" items={businessTagOptions?.LANGUAGE??[]} multiple required={false} selectedCodes={stringList(item?.languageTags)}/></>;
  if(action.id==='EDIT_PLAYER_COMPENSATION')return <PlayerCompensationFields offerings={serviceCatalogOptions??[]}/>;
  if(action.id==='REJECT_COMPANION')return <label className="field field--full"><span>拒绝说明</span><textarea name="note" required rows={4} maxLength={1000}/></label>;
  if (action.id === 'SET_OPERATIONAL_STATUS'||action.id==='SET_PLAYER_OPERATIONAL_STATUS') return <>
    <label className="field"><span>目标状态</span><select name="status" required defaultValue="PAUSED"><option value="ACTIVE">恢复</option><option value="PAUSED">暂停</option><option value="SUSPENDED">停用</option></select></label>
    <label className="field field--full"><span>处理说明</span><textarea name="note" rows={3} maxLength={1000} /></label>{action.id==='SET_PLAYER_OPERATIONAL_STATUS'?<p className="field-help field--full">此状态由员工控制候选池与新订单申请资格；Discord 在线状态仅供诊断。</p>:null}
  </>;
  if (action.id === 'CREATE_GIFT') return <GiftCatalogFields options={businessTagOptions}/>;
  if (action.id === 'CREATE_SERVICE_VERSION') return <ServiceCatalogFields options={businessTagOptions}/>;
  if(action.id==='CREATE_PACKAGE_VERSION'||action.id==='COPY_PACKAGE_VERSION')return <ServicePackageFields key={textValue(item?.id)||'new-package'} catalogs={serviceCatalogOptions??[]} item={action.id==='COPY_PACKAGE_VERSION'?item:undefined}/>;
  if(action.id==='UPDATE_PACKAGE_STATUS')return <PackageStatusFields item={item}/>;
  if (action.id === 'UPDATE_GIFT_VERSION') return <VersionActionFields action={action} replacementAction="CREATE_REPLACEMENT_VERSION" replacementFields={<GiftCatalogFields options={businessTagOptions} item={item}/>} />;
  if (action.id === 'UPDATE_VERSION') return <VersionActionFields action={action} replacementAction="SUPERSEDE" replacementFields={<ServiceCatalogFields options={businessTagOptions} item={item}/>} />;
  if(action.id==='ARCHIVE_SERVICE'||action.id==='ARCHIVE_GIFT')return <div className="field field--full archive-warning"><strong>确认归档当前版本？</strong><p>归档后当前版本不再出现在新业务目录中；历史订单、礼物记录和原有金额保持不变。</p></div>;
  if (action.id === 'CREATE_RISK_EVENT') return <>
    <label className="field"><span>事件类型</span><select name="type" required defaultValue="PAYMENT_ANOMALY"><option value="PAYMENT_ANOMALY">支付异常</option><option value="DUPLICATE_ACCOUNT_SIGNAL">重复账号信号</option><option value="REFERRAL_ABUSE_SIGNAL">返佣滥用信号</option><option value="PLAYER_NO_SHOW">陪玩未到场</option><option value="CUSTOMER_NO_SHOW">用户未到场</option></select></label>
    <label className="field"><span>严重程度</span><select name="severity" required defaultValue="MEDIUM"><option value="LOW">低</option><option value="MEDIUM">中</option><option value="HIGH">高</option></select></label>
    <label className="field"><span>来源</span><select name="source" required defaultValue="STAFF_REVIEW"><option value="STAFF_REVIEW">员工复核</option><option value="CUSTOMER_REPORT">用户反馈</option><option value="PLAYER_REPORT">陪玩反馈</option><option value="SYSTEM_SIGNAL">系统信号</option></select></label>
    <label className="field"><span>关联订单 ID（可选）</span><input name="orderId" maxLength={100} /></label>
    <label className="field field--full"><span>说明</span><textarea name="notes" required rows={4} maxLength={2000} /></label>
  </>;
  return null;
}

function StandaloneRefundFields({item}:{item?:Record<string,unknown>}) {
  const currency=textValue(item?.currency)||'CAT';
  const amountMinor=numberValue(item?.refundableAmountMinor)??numberValue(item?.amountMinor)??0;
  const amountCat=minorToCatInput(amountMinor);
  return <>
    <div className="field field--full context-note"><strong>订单保持原状态</strong><p>这是独立资金退款，只追加退款与关联冲正，不会取消订单或覆盖原账目。</p></div>
    <input type="hidden" name="currency" value={currency}/>
    <label className="field"><span>退款金额（猫条）</span><input name="amountCat" type="number" required min="0.1" max={amountCat} step="0.1"/><small>当前最多可提交 {amountCat} 猫条，最终以系统确认的可退款金额为准。</small></label>
    <label className="field"><span>退款原因</span><select name="reasonCode" required defaultValue="PARTIAL_SERVICE_REFUND"><option value="PARTIAL_SERVICE_REFUND">部分服务退款</option><option value="QUALITY_COMPLAINT">服务质量投诉</option><option value="SERVICE_INTERRUPTED">服务中断</option><option value="ADMIN_CORRECTION">管理员纠正</option></select></label>
    <label className="field field--full"><span>核对证据与处理说明</span><textarea name="evidenceNote" required rows={4} maxLength={2000} placeholder="说明客户诉求、服务进度、双方沟通和退款依据。"/></label>
  </>;
}

function OrderCancellationResolutionFields({item}:{item?:Record<string,unknown>}) {
  const currency=textValue(item?.currency)||'CAT';
  const amountMinor=numberValue(item?.amountMinor)??0;
  const playerEarningMinor=numberValue(item?.playerEarningMinor)??0;
  const amountCat=minorToCatInput(amountMinor);
  const playerEarningCat=minorToCatInput(playerEarningMinor);
  return <>
    <div className="field field--full archive-warning"><strong>确认取消并结案？</strong><p>该操作会同时处理预留、退款、陪玩收益和审计记录；订单进入 CANCELLED 后不能恢复。</p></div>
    <input type="hidden" name="currency" value={currency}/>
    <label className="field"><span>退回客户（猫条）</span><input name="refundAmountCat" type="number" required min={0} max={amountCat} step="0.1" defaultValue={amountCat}/><small>最多 {amountCat} 猫条；未扣款订单将按此金额释放预留。</small></label>
    <label className="field"><span>保留陪玩收益（猫条）</span><input name="playerEarningCat" type="number" required min={0} max={playerEarningCat} step="0.1" defaultValue={0}/><small>最多 {playerEarningCat} 猫条；依据已完成服务量人工核对。</small></label>
    <label className="field field--full"><span>核对证据与处理说明</span><textarea name="evidenceNote" required rows={4} maxLength={2000} placeholder="说明已核对的订单频道、服务进度与退款/收益依据。"/></label>
  </>;
}

function PlayerCompensationFields({offerings}:{offerings:Array<Record<string,unknown>>}){
  const firstId=textValue(offerings[0]?.serviceOfferingId);
  const[selected,setSelected]=useState(firstId);
  const [compensationDrafts,setCompensationDrafts]=useState<Record<string,CompensationDraft>>(()=>createCompensationDrafts(offerings));
  useEffect(()=>{if(!offerings.length){setSelected('');return;}if(!offerings.some((item)=>textValue(item.serviceOfferingId)===selected))setSelected(textValue(offerings[0].serviceOfferingId));setCompensationDrafts((current)=>mergeCompensationDrafts(current,offerings));},[offerings,selected]);
  const selectedOffering=offerings.find((item)=>textValue(item.serviceOfferingId)===selected);
  const rule=selectedOffering?.compensationRule as Record<string,unknown>|undefined;
  const draft=compensationDrafts[selected]??compensationDraft(selectedOffering);
  const updateDraft=(next:Partial<CompensationDraft>)=>setCompensationDrafts((current)=>({...current,[selected]:{...draft,...next}}));
  const changedDrafts=offerings.flatMap((item)=>{const serviceOfferingId=textValue(item.serviceOfferingId);const itemDraft=compensationDrafts[serviceOfferingId]??compensationDraft(item);return compensationDraftChanged(itemDraft,item.compensationRule as Record<string,unknown>|undefined)?[{serviceOfferingId,expectedVersion:typeof (item.compensationRule as Record<string,unknown>|undefined)?.version==='number'?String((item.compensationRule as Record<string,unknown>).version):'',...itemDraft}]:[];});
  return <>
    <section className="field field--full player-compensation-browser" aria-labelledby="player-compensation-title">
      <div className="player-compensation-browser__heading"><div><span id="player-compensation-title">陪玩项目分成</span><p>全部项目与当前规则同时展示；选择一项后在下方编辑。</p></div><strong>{offerings.length} 个项目</strong></div>
      {offerings.length===0?<p className="player-compensation-empty">当前没有已启用的服务项目。</p>:<div className="player-compensation-list" role="radiogroup" aria-label="选择要编辑的陪玩项目">{offerings.map((item)=>{
        const id=textValue(item.serviceOfferingId);const itemRule=item.compensationRule as Record<string,unknown>|undefined;const itemDraft=compensationDrafts[id]??compensationDraft(item);const active=selected===id;const changed=compensationDraftChanged(itemDraft,itemRule);
        return <label className={`player-compensation-item${active?' player-compensation-item--selected':''}`} key={id}>
          <input type="radio" name="serviceOfferingId" value={id} checked={active} required onChange={()=>setSelected(id)}/>
          <span className="player-compensation-item__content"><span className="player-compensation-item__project"><strong>{compensationProjectName(item)}</strong><small>{[item.regionDisplayName??item.region,typeof item.billingUnitMinutes==='number'?`${item.billingUnitMinutes} 分钟/单位`:null].filter(Boolean).join(' · ')||'不限区服'}</small></span><span className="player-compensation-item__rule"><small>{changed?'草稿已缓存':itemRule?'当前个人分成':'当前生效分成'}</small><strong>{changed?compensationDraftText(itemDraft):compensationRuleText(itemRule,item)}</strong><span>项目默认分成 {defaultCompensationText(item)}</span></span><span className="player-compensation-item__action">{active?'正在编辑':changed?'有草稿':'编辑'}</span></span>
        </label>;
      })}</div>}
    </section>
    <input type="hidden" name="compensationChangesJson" value={JSON.stringify(changedDrafts)}/>
    {selectedOffering&&<><div className="field field--full player-compensation-editor-heading"><span>编辑 {compensationProjectName(selectedOffering)}</span><small>本次将保存全部已缓存的项目草稿</small></div>
      <input type="hidden" name="compensationVersion" value={typeof rule?.version==='number'?rule.version:''}/>
      <label className="field"><span>分成方式</span><select name="compensationType" value={draft.type} onChange={(event)=>updateDraft({type:event.currentTarget.value as CompensationDraft['type']})}><option value="PERCENT_BPS">按客户价格比例</option><option value="FIXED_MINOR">每计费单位固定金额</option></select></label>
      {draft.type==='PERCENT_BPS'?<label className="field"><span>分成比例（%）</span><input name="percentage" type="number" required min="0.01" max="100" step="0.01" placeholder="例如 60" value={draft.percentage} onChange={(event)=>updateDraft({percentage:event.currentTarget.value})}/></label>:<label className="field"><span>每单位固定收益（猫条）</span><input name="fixedAmountCat" type="number" required min="0.1" step="0.1" value={draft.fixedAmountCat} onChange={(event)=>updateDraft({fixedAmountCat:event.currentTarget.value})}/></label>}
      <p className="field-help field--full">输入会即时缓存到本窗口的项目草稿；点击提交后仍需在确认窗口确认，才会保存。修改不会追溯已接单订单。</p></>}
  </>;
}

function compensationProjectName(item:Record<string,unknown>):string{return [item.gameDisplayName??item.game,item.serviceDisplayName??item.service].filter(Boolean).join(' · ')||'未命名项目';}
function defaultCompensationText(item:Record<string,unknown>):string{return typeof item.defaultPlayerPayoutBps==='number'?`${(item.defaultPlayerPayoutBps/100).toFixed(2)}%`:'未配置';}
function compensationRuleText(rule:Record<string,unknown>|undefined,item:Record<string,unknown>):string{if(rule?.type==='PERCENT_BPS'&&typeof rule.value==='number')return `${(rule.value/100).toFixed(2)}%`;if(rule?.type==='FIXED_MINOR'&&typeof rule.value==='number')return `${formatMinorCurrency(rule.value,textValue(rule.currency)||textValue(item.currency)||'CAT')}/单位`;return defaultCompensationText(item);}
type CompensationDraft={type:'PERCENT_BPS'|'FIXED_MINOR';percentage:string;fixedAmountCat:string};
function compensationDraft(item?:Record<string,unknown>):CompensationDraft{const rule=item?.compensationRule as Record<string,unknown>|undefined;return{type:rule?.type==='FIXED_MINOR'?'FIXED_MINOR':'PERCENT_BPS',percentage:rule?.type==='PERCENT_BPS'&&typeof rule.value==='number'?String(rule.value/100):'',fixedAmountCat:rule?.type==='FIXED_MINOR'&&typeof rule.value==='number'?minorToCatInput(rule.value):''};}
function createCompensationDrafts(offerings:Array<Record<string,unknown>>):Record<string,CompensationDraft>{return Object.fromEntries(offerings.map((item)=>[textValue(item.serviceOfferingId),compensationDraft(item)]));}
function mergeCompensationDrafts(current:Record<string,CompensationDraft>,offerings:Array<Record<string,unknown>>):Record<string,CompensationDraft>{const next={...current};for(const item of offerings){const id=textValue(item.serviceOfferingId);if(!next[id])next[id]=compensationDraft(item);}return next;}
function compensationDraftChanged(draft:CompensationDraft,rule:Record<string,unknown>|undefined):boolean{if(draft.type!==textValue(rule?.type||'PERCENT_BPS'))return Boolean(draft.percentage||draft.fixedAmountCat||rule);const current=draft.type==='PERCENT_BPS'&&typeof rule?.value==='number'?String(rule.value/100):draft.type==='FIXED_MINOR'&&typeof rule?.value==='number'?minorToCatInput(rule.value):'';return (draft.type==='PERCENT_BPS'?draft.percentage:draft.fixedAmountCat)!==current;}
function compensationDraftText(draft:CompensationDraft|Record<string,string|boolean>):string{const type='compensationType'in draft?draft.compensationType:draft.type;if(type==='FIXED_MINOR'){const value=typeof draft.fixedAmountCat==='string'?draft.fixedAmountCat:'';return value?`${value} 猫条/单位`:'未填写';}const value=typeof draft.percentage==='string'?draft.percentage:'';return value?`${value}%`:'未填写';}

function GiftCatalogFields({options,item}:{options?:BusinessTagGroups;item?:Record<string,unknown>}) {
  const priceMinor=numberValue(item?.priceMinor);
  return <>
    <label className="field"><span>礼物名称</span><input name="name" required maxLength={100} defaultValue={textValue(item?.name)} /></label>
    <TagSelect name="giftCategoryTagId" label="礼物分类" items={options?.GIFT_CATEGORY??[]} selectedValue={textValue(item?.giftCategoryTagId)}/>
    <label className="field"><span>价格（猫条）</span><input name="amountCat" type="number" required min="0.1" step="0.1" defaultValue={priceMinor===undefined?undefined:minorToCatInput(priceMinor)} /></label>
    <label className="field"><span>币种</span><select name="currency" required defaultValue="CAT"><option value="CAT">猫条（CAT）</option></select></label>
    <label className="checkbox-field"><input name="enabled" type="checkbox" defaultChecked={item?.enabled!==false} /><span>立即启用</span></label>
    <label className="field field--full"><span>播报模板</span><textarea name="broadcastTemplate" required rows={3} maxLength={500} defaultValue={textValue(item?.broadcastTemplate)} /></label>
  </>;
}

function ServiceCatalogFields({options,item}:{options?:BusinessTagGroups;item?:Record<string,unknown>}) {
  const customerUnitPriceMinor=numberValue(item?.customerUnitPriceMinor);
  return <>
    <TagSelect name="gameTagId" label="游戏" items={options?.GAME??[]} selectedCodes={[textValue(item?.game)]}/>
    <TagSelect name="serviceTagId" label="服务/种类" items={options?.SERVICE??[]} selectedCodes={[textValue(item?.service)]}/>
    <TagSelect name="regionTagId" label="地区（可选）" items={options?.REGION??[]} required={false} selectedCodes={[textValue(item?.region)]}/>
    <label className="field"><span>计费单位（分钟）</span><input name="billingUnitMinutes" type="number" required min={1} max={1440} step={1} defaultValue={numberValue(item?.billingUnitMinutes)} /></label>
    <label className="field"><span>最少单位数</span><input name="minimumUnits" type="number" required min={1} max={1440} step={1} defaultValue={numberValue(item?.minimumUnits)} /></label>
    <label className="field"><span>用户单价（猫条）</span><input name="customerAmountCat" type="number" required min="0.1" step="0.1" defaultValue={customerUnitPriceMinor===undefined?undefined:minorToCatInput(customerUnitPriceMinor)} /></label>
    <label className="field"><span>默认陪玩分成（%）</span><input name="defaultPlayerPayoutPercent" type="number" required min="0.01" max="100" step="0.01" defaultValue={typeof item?.defaultPlayerPayoutBps==='number'?item.defaultPlayerPayoutBps/100:60} /></label>
    <label className="field"><span>币种</span><select name="currency" required defaultValue="CAT"><option value="CAT">猫条（CAT）</option></select></label>
    <label className="checkbox-field"><input name="enabled" type="checkbox" defaultChecked={item?.enabled!==false} /><span>立即启用</span></label>
  </>;
}

function ServicePackageFields({catalogs,item}:{catalogs:Array<Record<string,unknown>>;item?:Record<string,unknown>}){
  const initialSlots=packageEditorSlots(item);
  const games=packageEditorGames(catalogs);
  const initialCatalog=catalogs.find(catalog=>textValue(catalog.id)===initialSlots[0]?.serviceCatalogVersionId);
  const[selectedGame,setSelectedGame]=useState(()=>textValue(item?.game)||textValue(initialCatalog?.game)||games[0]?.[0]||'');
  const[slots,setSlots]=useState<Array<{key:string;serviceCatalogVersionId:string;unitCount:number;customerNoteTemplate:string}>>(()=>initialSlots);
  const effectiveSelectedGame=games.some(([code])=>code===selectedGame)?selectedGame:games[0]?.[0]||'';
  const availableCatalogs=catalogs.filter(catalog=>textValue(catalog.game)===effectiveSelectedGame);
  const derivedTotalMinor=slots.reduce<number|null>((total,slot)=>{const catalog=catalogs.find(item=>textValue(item.id)===slot.serviceCatalogVersionId);const unitPrice=numberValue(catalog?.customerUnitPriceMinor);return total===null||unitPrice===undefined||!Number.isSafeInteger(slot.unitCount)||slot.unitCount<1?null:total+unitPrice*slot.unitCount;},0);
  const serialized=JSON.stringify(slots.map(({serviceCatalogVersionId,unitCount,customerNoteTemplate})=>({serviceCatalogVersionId,unitCount,customerNoteTemplate:customerNoteTemplate.trim()||null})));
  return <>
  {item&&<p className="field-help field--full">将基于当前版本创建一份可编辑的新版本；历史订单与原版本不会被改写。</p>}
  <label className="field"><span>套餐所属游戏</span><select value={effectiveSelectedGame} onChange={(event)=>{const game=event.currentTarget.value;setSelectedGame(game);setSlots(current=>current.map(slot=>catalogs.some(catalog=>textValue(catalog.id)===slot.serviceCatalogVersionId&&textValue(catalog.game)===game)?slot:{...slot,serviceCatalogVersionId:''}));}}>{games.map(([code,name])=><option key={code} value={code}>{name}</option>)}</select><small>一个套餐只能包含同一游戏的服务项目，系统会按席位核对并保存归属。</small></label>
  <label className="field"><span>稳定代码</span><input name="code" required maxLength={100} pattern="[A-Z0-9_]{2,100}" placeholder="DELTA_ESCORT" defaultValue={textValue(item?.code)}/></label>
  <label className="field"><span>展示名称</span><input name="displayName" required maxLength={100} placeholder="三角洲护航" defaultValue={textValue(item?.displayName)}/></label>
  <label className="field field--full"><span>套餐说明</span><textarea name="description" required rows={3} maxLength={1000} placeholder="两只技术猫猫护航，也可以把其中一席换成聊天陪伴。" defaultValue={textValue(item?.description)}/></label>
  <div className="field"><span>套餐总价（自动计算）</span><output aria-live="polite"><strong>{derivedTotalMinor===null?'选择有效服务项目后显示':formatMinorCurrency(derivedTotalMinor,'CAT')}</strong></output><small>按每个席位的服务目录单价 × 计费单位数汇总；最终金额以系统保存结果为准。</small></div>
  <label className="checkbox-field"><input name="activate" type="checkbox"/><span>创建后立即发布</span></label>
  <input type="hidden" name="slotsJson" value={serialized}/>
  <fieldset className="field field--full package-slot-editor"><legend>默认陪玩席位（按顺序）</legend>{slots.map((slot,index)=><div className="package-slot-row" key={slot.key}><strong>{index+1} 号位</strong><label><span>服务项目</span><select required value={slot.serviceCatalogVersionId} onChange={(event)=>{const value=event.currentTarget.value;setSlots(current=>current.map(item=>item.key===slot.key?{...item,serviceCatalogVersionId:value}:item));}}><option value="">请选择</option>{availableCatalogs.map(catalog=><option key={String(catalog.id)} value={String(catalog.id)}>{`${String(catalog.gameDisplayName??catalog.game)} · ${String(catalog.serviceDisplayName??catalog.service)}${catalog.regionDisplayName?` · ${String(catalog.regionDisplayName)}`:''}`}</option>)}</select></label><label><span>计费单位数</span><input type="number" min="1" step="1" value={slot.unitCount} onChange={(event)=>{const value=Number(event.currentTarget.value);setSlots(current=>current.map(item=>item.key===slot.key?{...item,unitCount:value}:item));}}/></label><label><span>默认偏好</span><input maxLength={500} value={slot.customerNoteTemplate} placeholder="例如：负责技术护航" onChange={(event)=>{const value=event.currentTarget.value;setSlots(current=>current.map(item=>item.key===slot.key?{...item,customerNoteTemplate:value}:item));}}/></label><button type="button" disabled={slots.length===1} onClick={()=>setSlots(current=>current.filter(item=>item.key!==slot.key))}>移除此席位</button></div>)}<button type="button" disabled={slots.length>=25} onClick={()=>setSlots(current=>[...current,{key:crypto.randomUUID(),serviceCatalogVersionId:'',unitCount:1,customerNoteTemplate:''}])}>添加陪玩席位</button><p className="field-help">每个席位都会生成一条独立需求，可分别匹配项目和陪玩。</p></fieldset>
</>}
function packageEditorSlots(item?:Record<string,unknown>):Array<{key:string;serviceCatalogVersionId:string;unitCount:number;customerNoteTemplate:string}>{const raw=Array.isArray(item?.slots)?item.slots:[];const slots=raw.map((slot)=>{const value=slot&&typeof slot==='object'&&!Array.isArray(slot)?slot as Record<string,unknown>:{};return{key:crypto.randomUUID(),serviceCatalogVersionId:textValue(value.serviceCatalogVersionId),unitCount:numberValue(value.unitCount)??1,customerNoteTemplate:textValue(value.customerNoteTemplate)};}).filter((slot)=>slot.serviceCatalogVersionId);return slots.length?slots:[{key:crypto.randomUUID(),serviceCatalogVersionId:'',unitCount:1,customerNoteTemplate:''}];}
function packageEditorGames(catalogs:Array<Record<string,unknown>>):Array<[string,string]>{const games=new Map<string,string>();for(const catalog of catalogs){const code=textValue(catalog.game);if(code&&!games.has(code))games.set(code,textValue(catalog.gameDisplayName)||code);}return [...games.entries()];}
function PackageStatusFields({item}:{item?:Record<string,unknown>}){const status=String(item?.status??'');return <div className="field field--full"><strong>{status==='DRAFT'?'发布这个草稿版本？':'退役这个启用版本？'}</strong><input type="hidden" name="action" value={status==='DRAFT'?'ACTIVATE':'RETIRE'}/><p>{status==='DRAFT'?'发布后，同套餐之前的启用版本会自动退役；历史订单仍保留原版本。':'退役后 Bot 不再向新订单展示该套餐，历史订单不受影响。'}</p></div>}

function TagSelect(props:{name:string;label:string;items:BusinessTagRecord[];multiple?:boolean;required?:boolean;selectedCodes?:string[];selectedValue?:string}){if(props.multiple)return <fieldset className="field tag-checklist"><legend>{props.label}</legend>{props.items.map((item)=><label className="checkbox-field" key={item.id}><input type="checkbox" name={props.name} value={item.id} defaultChecked={props.selectedCodes?.includes(item.code)}/><span>{item.displayName} · {item.code}</span></label>)}</fieldset>;const selected=props.selectedValue||props.items.find((item)=>props.selectedCodes?.includes(item.code))?.id||'';return <label className="field"><span>{props.label}</span><select name={props.name} required={props.required??true} defaultValue={selected}><option value="" disabled={props.required??true}>请选择</option>{props.items.map((item)=><option key={item.id} value={item.id}>{item.displayName} · {item.code}</option>)}</select></label>}
function stringList(value:unknown):string[]{return Array.isArray(value)?value.filter((item):item is string=>typeof item==='string'):[];}

function VersionActionFields(props: { action: AdminBusinessAction; replacementAction: string; replacementFields: ReactNode }) {
  const [action, setAction] = useState(props.replacementAction);
  return <>
    <label className="field"><span>操作</span><select name="action" required value={action} onChange={(event) => setAction(event.currentTarget.value)}><option value={props.replacementAction}>保存修改（创建新版本）</option><option value="ENABLE">启用</option><option value="DISABLE">停用</option></select></label>
    {action === props.replacementAction && props.replacementFields}
  </>;
}

function collectActionFields(form: HTMLFormElement): Record<string, string | boolean> {
  const fields: Record<string, string | boolean> = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (typeof value === 'string') fields[key] = typeof fields[key] === 'string' ? `${fields[key]},${value}` : value;
  }
  const enabled = form.elements.namedItem('enabled');
  if (enabled instanceof HTMLInputElement) fields.enabled = enabled.checked;
  const activate=form.elements.namedItem('activate');
  if(activate instanceof HTMLInputElement)fields.activate=activate.checked;
  return fields;
}
