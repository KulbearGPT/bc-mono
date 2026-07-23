const ORDER_STATUS_LABELS: Readonly<Record<string, string>> = {
  DRAFT: '需求编辑中',
  PENDING_DISPATCH: '等待招募与试音匹配',
  ACCEPTED: '已确认陪玩，等待双方就绪',
  IN_SERVICE: '陪玩服务进行中',
  PENDING_CONFIRMATION: '等待老板确认完成',
  COMPLETED: '已完成',
  CANCELLED: '已取消',
  EXCEPTION: '客服处理中'
};

export function orderStatusDisplay(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}
