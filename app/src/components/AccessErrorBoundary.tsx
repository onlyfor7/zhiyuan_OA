import type { ReactNode } from "react";
import { Component, Suspense, lazy } from "react";
import { Navigate } from "react-router";

import { isAccessDeniedOrGone, isAuthRequired, queryClient } from "../lib/trpc";

const NotFoundPage = lazy(() => import("../pages/NotFoundPage"));

interface BoundaryProps {
  children: ReactNode;
  from: string;
}

interface BoundaryState {
  error: unknown;
}

/**
 * 路由错误边界（iter10-02 抽出为独立组件，逐页签包裹）：
 * ACCESS_DENIED_OR_GONE → 403/404 同形页（不泄露存在性）；
 * AUTH_REQUIRED → 跳登录并保留回跳地址；其余错误 → 可重试的错误态。
 */
export class AccessErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error };
  }

  override render() {
    const { error } = this.state;
    if (error !== null && error !== undefined) {
      if (isAccessDeniedOrGone(error)) {
        return (
          <Suspense fallback={null}>
            <NotFoundPage fixedCode="404" />
          </Suspense>
        );
      }
      if (isAuthRequired(error)) {
        return <Navigate to="/login" replace state={{ from: this.props.from }} />;
      }
      return (
        <div className="error-state" role="alert">
          <strong>页面加载失败</strong>
          <p>请求未成功完成，请重试；若持续失败请联系系统管理员。</p>
          <button
            className="secondary-action"
            onClick={() => {
              void queryClient.invalidateQueries();
              this.setState({ error: null });
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
