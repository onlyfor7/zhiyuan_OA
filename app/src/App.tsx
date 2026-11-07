import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router";

import AppShell from "./components/AppShell";

const ArchivePage = lazy(() => import("./pages/ArchivePage"));
const AuditPage = lazy(() => import("./pages/AuditPage"));
const CockpitPage = lazy(() => import("./pages/CockpitPage"));
const DecisionNewPage = lazy(() => import("./pages/DecisionNewPage"));
const DecisionsPage = lazy(() => import("./pages/DecisionsPage"));
const LoginPage = lazy(() => import("./pages/LoginPage"));
const MeetingDetailPage = lazy(() => import("./pages/MeetingDetailPage"));
const MeetingNewPage = lazy(() => import("./pages/MeetingNewPage"));
const MeetingsPage = lazy(() => import("./pages/MeetingsPage"));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage"));
const NotificationsPage = lazy(() => import("./pages/NotificationsPage"));
const ComingSoonPage = lazy(() => import("./pages/ComingSoonPage"));
const OrgCompanyPage = lazy(() => import("./pages/org/OrgCompanyPage"));
const OrgUnitsPage = lazy(() => import("./pages/org/OrgUnitsPage"));
const OrgMembersPage = lazy(() => import("./pages/org/OrgMembersPage"));
const CrmLeadsPage = lazy(() => import("./pages/crm/LeadsPage"));
const CrmCustomersPage = lazy(() => import("./pages/crm/CustomersPage"));
const CrmCustomerDetailPage = lazy(() => import("./pages/crm/CustomerDetailPage"));
const CrmOpportunitiesPage = lazy(() => import("./pages/crm/OpportunitiesPage"));
const CrmContractsPage = lazy(() => import("./pages/crm/ContractsPage"));
const CrmFollowupsPage = lazy(() => import("./pages/crm/FollowupsPage"));
const AdminCenterPage = lazy(() => import("./pages/admin/AdminCenterPage"));
const FlowDesignerPage = lazy(() => import("./pages/admin/FlowDesignerPage"));
const RequestsPage = lazy(() => import("./pages/RequestsPage"));
const RequestDetailPage = lazy(() =>
  import("./pages/RequestsPage").then((m) => ({ default: m.RequestDetailPage })),
);
const ReceiptsPage = lazy(() => import("./pages/ReceiptsCenterPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const ApprovalsPage = lazy(() => import("./pages/ApprovalsPage"));
const ProjectCreatePage = lazy(() => import("./pages/ProjectCreatePage"));
const ProjectsPage = lazy(() => import("./pages/ProjectsPage"));
const QualityPage = lazy(() => import("./pages/QualityPage"));
const TravelDetailPage = lazy(() => import("./pages/TravelDetailPage"));
const TravelNewPage = lazy(() => import("./pages/TravelNewPage"));
const TravelPage = lazy(() => import("./pages/TravelPage"));
const WorkbenchPage = lazy(() => import("./pages/WorkbenchPage"));
const OperationsBudgetPage = lazy(() => import("./pages/OperationsBudgetPage"));
const OperationsExpensesPage = lazy(() => import("./pages/OperationsExpensesPage"));
const FundingDetailPage = lazy(() => import("./pages/FundingDetailPage"));
const FundingNewPage = lazy(() => import("./pages/FundingNewPage"));
const ExpenseDetailPage = lazy(() => import("./pages/ExpenseDetailPage"));
const ExpenseNewPage = lazy(() => import("./pages/ExpenseNewPage"));
const ProjectSpacePage = lazy(() => import("./pages/project/ProjectSpacePage"));
const OverviewTab = lazy(() => import("./pages/project/OverviewTab"));
const PlanTab = lazy(() => import("./pages/project/PlanTab"));
const TasksTab = lazy(() => import("./pages/project/TasksTab"));
const QualityTab = lazy(() => import("./pages/project/QualityTab"));
const DecisionsTab = lazy(() => import("./pages/project/DecisionsTab"));
const ReportsTab = lazy(() => import("./pages/project/ReportsTab"));
const ArchiveTab = lazy(() => import("./pages/project/ArchiveTab"));
const MembersTab = lazy(() => import("./pages/project/MembersTab"));
const TimeCenterPage = lazy(() => import("./pages/TimeCenterPage"));
const SearchPage = lazy(() => import("./pages/SearchPage"));
const MeetingsTab = lazy(() => import("./pages/project/MeetingsTab"));
const ProjectFlowsTab = lazy(() => import("./pages/project/FlowsTab"));
const TravelTab = lazy(() => import("./pages/project/TravelTab"));
const BudgetTab = lazy(() => import("./pages/project/BudgetTab"));
const ExpensesTab = lazy(() => import("./pages/project/ExpensesTab"));
const TimesheetTab = lazy(() => import("./pages/project/TimesheetTab"));
const FinReceivablesPage = lazy(() => import("./pages/fin/ReceivablesPage"));
const FinInvoicesPage = lazy(() => import("./pages/fin/InvoicesPage"));
const FinProjectCostingPage = lazy(() => import("./pages/fin/ProjectCostingPage"));
const ReportsWorkbenchPage = lazy(() => import("./pages/reports/ReportsWorkbenchPage"));
const ReportPage = lazy(() => import("./pages/reports/ReportPage"));

/**
 * 路由表（迭代 1 工单 03；迭代 6 工单 04 扩展域转正）。
 * 项目空间为页签式嵌套路由：8 个真实数据页签 + 5 个后续迭代占位页签。
 */
export default function App() {
  return (
    <Suspense fallback={<div className="page-loader" role="status">正在加载…</div>}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/coming-soon" element={<ComingSoonPage />} />
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/cockpit" replace />} />
        <Route path="/cockpit" element={<CockpitPage />} />
        <Route path="/workbench" element={<WorkbenchPage />} />
        <Route path="/approvals" element={<ApprovalsPage />} />
        <Route path="/admin" element={<AdminCenterPage />} />
        <Route path="/admin/flows/:flowId" element={<FlowDesignerPage />} />
        <Route path="/requests" element={<RequestsPage />} />
        <Route path="/requests/:requestId" element={<RequestDetailPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/admin/org/company" element={<OrgCompanyPage />} />
        <Route path="/admin/org/units" element={<OrgUnitsPage />} />
        <Route path="/admin/org/members" element={<OrgMembersPage />} />
        <Route path="/crm/leads" element={<CrmLeadsPage />} />
        <Route path="/crm/opportunities" element={<CrmOpportunitiesPage />} />
        <Route path="/crm/customers" element={<CrmCustomersPage />} />
        <Route path="/crm/customers/:customerId" element={<CrmCustomerDetailPage />} />
        <Route path="/crm/contracts" element={<CrmContractsPage />} />
        <Route path="/crm/followups" element={<CrmFollowupsPage />} />
        <Route path="/admin/users" element={<Navigate to="/admin/org/members" replace />} />
        <Route path="/operations/receipts" element={<ReceiptsPage />} />
        <Route path="/fin/receivables" element={<FinReceivablesPage />} />
        <Route path="/fin/invoices" element={<FinInvoicesPage />} />
        <Route path="/fin/project-costing" element={<FinProjectCostingPage />} />
        <Route path="/reports" element={<ReportsWorkbenchPage />} />
        <Route path="/reports/:key" element={<ReportPage />} />
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
          <Route path="timesheet" element={<TimesheetTab />} />
          <Route path="flows" element={<ProjectFlowsTab />} />
          <Route path="*" element={<Navigate to="overview" replace />} />
        </Route>
        <Route path="/operations/time" element={<TimeCenterPage />} />
        <Route path="/search" element={<SearchPage />} />
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
    </Suspense>
  );
}
