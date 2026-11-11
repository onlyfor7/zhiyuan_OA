import { lazy, Suspense, useEffect, useState } from "react";
import { Route, Routes } from "react-router";

import AppShell from "./components/AppShell";

/**
 * 根路由（iter10-02）：/login、/403、/404 与 /*（应用壳=多页签工作区）。
 * 壳内详细路由表见 components/workspace/AppRoutes.tsx（按页签 location 渲染，keep-alive）。
 * AppShell 保持静态引入——壳懒加载会让每次重载整页回退根 Suspense（E2 类 500ms 阈值断言抖动）。
 */

const LoginPage = lazy(() => import("./pages/LoginPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));

/** §18.1 缓冲骨架：<150ms 完成则不出（防闪烁）；品牌脉冲而非白屏 */
function DelayedBrandFallback() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setShow(true), 150);
    return () => window.clearTimeout(t);
  }, []);
  if (!show) return null;
  return (
    <div className="page-loader brand-pulse" role="status" aria-label="正在加载">
      <span className="brand-mark" aria-hidden="true"><span /><span /><span /></span>
      <span>因诺智元 · 加载中</span>
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<DelayedBrandFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/403" element={<NotFoundPage fixedCode="403" />} />
        <Route path="/404" element={<NotFoundPage fixedCode="404" />} />
        <Route path="/*" element={<AppShell />} />
      </Routes>
    </Suspense>
  );
}
