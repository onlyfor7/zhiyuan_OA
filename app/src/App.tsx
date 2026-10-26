import { Navigate, Route, Routes } from "react-router";

import AppShell from "./components/AppShell";
import ArchivePage from "./pages/ArchivePage";
import AuditPage from "./pages/AuditPage";
import CockpitPage from "./pages/CockpitPage";
import DecisionsPage from "./pages/DecisionsPage";
import GanttPage from "./pages/GanttPage";
import LoginPage from "./pages/LoginPage";
import NotFoundPage from "./pages/NotFoundPage";
import ProjectDetailPage from "./pages/ProjectDetailPage";
import ProjectsPage from "./pages/ProjectsPage";
import QualityPage from "./pages/QualityPage";
import WorkbenchPage from "./pages/WorkbenchPage";

/**
 * 路由表（工单 04；react-router 7）。
 * 认证壳 AppShell 守卫全部业务路由：未认证 → /login（保留回跳地址）；
 * 无权限详情 → 403/404 同形页（错误边界内渲染）。
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/cockpit" replace />} />
        <Route path="/cockpit" element={<CockpitPage />} />
        <Route path="/workbench" element={<WorkbenchPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
        <Route path="/projects/:projectId/plan" element={<GanttPage />} />
        <Route path="/quality" element={<QualityPage />} />
        <Route path="/decisions" element={<DecisionsPage />} />
        <Route path="/archive" element={<ArchivePage />} />
        <Route path="/audit" element={<AuditPage />} />
      </Route>
      <Route path="/403" element={<NotFoundPage fixedCode="403" />} />
      <Route path="/404" element={<NotFoundPage fixedCode="404" />} />
      <Route path="*" element={<NotFoundPage fixedCode="404" />} />
    </Routes>
  );
}
