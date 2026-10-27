import { Navigate, Route, Routes } from "react-router";

import AppShell from "./components/AppShell";
import ArchivePage from "./pages/ArchivePage";
import AuditPage from "./pages/AuditPage";
import CockpitPage from "./pages/CockpitPage";
import DecisionNewPage from "./pages/DecisionNewPage";
import DecisionsPage from "./pages/DecisionsPage";
import LoginPage from "./pages/LoginPage";
import MeetingDetailPage from "./pages/MeetingDetailPage";
import MeetingNewPage from "./pages/MeetingNewPage";
import MeetingsPage from "./pages/MeetingsPage";
import NotFoundPage from "./pages/NotFoundPage";
import ApprovalsPage from "./pages/ApprovalsPage";
import ProjectCreatePage from "./pages/ProjectCreatePage";
import ProjectsPage from "./pages/ProjectsPage";
import QualityPage from "./pages/QualityPage";
import TravelDetailPage from "./pages/TravelDetailPage";
import TravelNewPage from "./pages/TravelNewPage";
import TravelPage from "./pages/TravelPage";
import WorkbenchPage from "./pages/WorkbenchPage";
import OperationsBudgetPage from "./pages/OperationsBudgetPage";
import OperationsExpensesPage from "./pages/OperationsExpensesPage";
import FundingDetailPage from "./pages/FundingDetailPage";
import FundingNewPage from "./pages/FundingNewPage";
import ExpenseDetailPage from "./pages/ExpenseDetailPage";
import ExpenseNewPage from "./pages/ExpenseNewPage";
import ProjectSpacePage, { FutureTab } from "./pages/project/ProjectSpacePage";
import OverviewTab from "./pages/project/OverviewTab";
import PlanTab from "./pages/project/PlanTab";
import TasksTab from "./pages/project/TasksTab";
import QualityTab from "./pages/project/QualityTab";
import DecisionsTab from "./pages/project/DecisionsTab";
import ReportsTab from "./pages/project/ReportsTab";
import ArchiveTab from "./pages/project/ArchiveTab";
import MembersTab from "./pages/project/MembersTab";
import MeetingsTab from "./pages/project/MeetingsTab";
import TravelTab from "./pages/project/TravelTab";
import BudgetTab from "./pages/project/BudgetTab";
import ExpensesTab from "./pages/project/ExpensesTab";

/**
 * 路由表（迭代 1 工单 03）。
 * 项目空间为页签式嵌套路由：8 个真实数据页签 + 5 个后续迭代占位页签。
 */
export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/cockpit" replace />} />
        <Route path="/cockpit" element={<CockpitPage />} />
        <Route path="/workbench" element={<WorkbenchPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/new" element={<ProjectCreatePage />} />
        <Route path="/projects/:projectId" element={<ProjectSpacePage />}>
          <Route index element={<Navigate to="overview" replace />} />
          <Route path="overview" element={<OverviewTab />} />
          <Route path="plan" element={<PlanTab />} />
          <Route path="tasks" element={<TasksTab />} />
          <Route path="quality" element={<QualityTab />} />
          <Route path="decisions" element={<DecisionsTab />} />
          <Route path="reports" element={<ReportsTab />} />
          <Route path="archive" element={<ArchiveTab />} />
          <Route path="members" element={<MembersTab />} />
          <Route path="meetings" element={<MeetingsTab />} />
          <Route path="travel" element={<TravelTab />} />
          <Route path="budget" element={<BudgetTab />} />
          <Route path="expenses" element={<ExpensesTab />} />
          <Route path="timesheet" element={<FutureTab label="工时" />} />
          <Route path="*" element={<Navigate to="overview" replace />} />
        </Route>
        <Route path="/operations/budget" element={<OperationsBudgetPage />} />
        <Route path="/operations/expenses" element={<OperationsExpensesPage />} />
        <Route path="/operations/funding/new" element={<FundingNewPage />} />
        <Route path="/operations/funding/:fundingId" element={<FundingDetailPage />} />
        <Route path="/expenses/new" element={<ExpenseNewPage />} />
        <Route path="/expenses/:expenseId" element={<ExpenseDetailPage />} />
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/meetings/new" element={<MeetingNewPage />} />
        <Route path="/meetings/:meetingId" element={<MeetingDetailPage />} />
        <Route path="/travel" element={<TravelPage />} />
        <Route path="/travel/new" element={<TravelNewPage />} />
        <Route path="/travel/:travelId" element={<TravelDetailPage />} />
        <Route path="/quality" element={<QualityPage />} />
        <Route path="/decisions" element={<DecisionsPage />} />
        <Route path="/decisions/new" element={<DecisionNewPage />} />
        <Route path="/archive" element={<ArchivePage />} />
        <Route path="/audit" element={<AuditPage />} />
      </Route>
      <Route path="/403" element={<NotFoundPage fixedCode="403" />} />
      <Route path="/404" element={<NotFoundPage fixedCode="404" />} />
      <Route path="*" element={<NotFoundPage fixedCode="404" />} />
    </Routes>
  );
}
