import { Component, type ErrorInfo, type ReactNode } from 'react';

interface DashboardErrorBoundaryProps { children: ReactNode }
interface DashboardErrorBoundaryState { hasError: boolean; incidentId: string | null }

export class DashboardErrorBoundary extends Component<DashboardErrorBoundaryProps, DashboardErrorBoundaryState> {
  state: DashboardErrorBoundaryState = { hasError: false, incidentId: null };

  static getDerivedStateFromError(): DashboardErrorBoundaryState {
    return { hasError: true, incidentId: crypto.randomUUID() };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // React reports the component stack in development. The incident ID gives staff a safe reference
    // without rendering exception details or response data into the operational workspace.
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;
    return <section className="state-card state-card--error" role="alert">
      <h1>当前页面无法安全显示</h1>
      <p>页面已停止渲染，未提交任何业务或资金操作。请重新载入后再试。</p>
      {this.state.incidentId && <p className="request-id">故障编号：{this.state.incidentId}</p>}
      <button type="button" onClick={() => window.location.reload()}>重新载入 Dashboard</button>
    </section>;
  }
}
