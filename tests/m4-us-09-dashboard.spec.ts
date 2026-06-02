import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { DashboardMetricSummary } from '../apps/dashboard/src/SupportWorkbenchPage.js';

const summary={windowStart:'2026-07-18T16:00:00.000Z',windowEnd:'2026-07-19T16:00:00.000Z',timeZone:'Asia/Shanghai',currency:'CAT',metrics:{todayOrderCount:42,inProgressOrderCount:11,pendingStaffTaskCount:8,completedOrderNetConsumptionMinor:842000,giftNetConsumptionMinor:193600,activeReservedMinor:216400,dispatchSuccessRateBps:9170,exceptionCount:3}};

describe('M4-US-09 Dashboard metric summary',()=>{
  test('renders all eight metrics with money and basis-point formatting',()=>{
    const html=renderToStaticMarkup(createElement(DashboardMetricSummary,{state:{kind:'READY',requestId:'req_metrics',data:summary}}));
    for(const label of ['今日订单','进行中订单','待处理任务','已完成净消费','礼物净消费','预留总额','派单成功率','异常数'])expect(html).toContain(label);
    expect(html).toContain('84,200.0 猫条');expect(html).toContain('91.70%');expect(html).toContain('Asia/Shanghai');
  });

  test('shows L1 redaction, loading, and request-id error states',()=>{
    const redacted=renderToStaticMarkup(createElement(DashboardMetricSummary,{state:{kind:'READY',requestId:null,data:{...summary,metrics:{...summary.metrics,completedOrderNetConsumptionMinor:null,giftNetConsumptionMinor:null,activeReservedMinor:null}}}}));
    expect(redacted.match(/无权限/g)).toHaveLength(3);
    expect(renderToStaticMarkup(createElement(DashboardMetricSummary,{state:{kind:'LOADING',requestId:null,data:null}}))).toContain('正在载入运营指标');
    expect(renderToStaticMarkup(createElement(DashboardMetricSummary,{state:{kind:'ERROR',requestId:'req_metric_error',data:null}}))).toContain('req_metric_error');
  });
});
