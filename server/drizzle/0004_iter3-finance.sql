CREATE TYPE "public"."budget_status" AS ENUM('draft', 'pending_approval', 'active', 'superseded', 'closed');--> statement-breakpoint
CREATE TYPE "public"."expense_category" AS ENUM('transport', 'accommodation', 'meals', 'meeting', 'materials', 'translation', 'notarization', 'travel_other');--> statement-breakpoint
CREATE TYPE "public"."expense_status" AS ENUM('draft', 'pending_approval', 'rejected', 'approved_pending_payment', 'paid');--> statement-breakpoint
CREATE TYPE "public"."funding_usage_status" AS ENUM('unused', 'partially_used', 'written_off', 'closed');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('BUDGET_ACTIVATED', 'BUDGET_ADJUSTED', 'FUNDING_RESERVED', 'FUNDING_RELEASED', 'EXPENSE_RECOGNIZED', 'EXPENSE_ADJUSTED');--> statement-breakpoint
CREATE TABLE "budget_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budget_id" uuid NOT NULL,
	"category" "expense_category" NOT NULL,
	"amount_cents" bigint NOT NULL,
	CONSTRAINT "budget_categories_budget_category_unique" UNIQUE("budget_id","category")
);
--> statement-breakpoint
CREATE TABLE "budget_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"project_id" uuid NOT NULL,
	"budget_version_id" uuid,
	"source_type" text NOT NULL,
	"source_id" uuid,
	"entry_type" "ledger_entry_type" NOT NULL,
	"reserved_delta_cents" bigint DEFAULT 0 NOT NULL,
	"actual_delta_cents" bigint DEFAULT 0 NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_ledger_code_unique" UNIQUE("code"),
	CONSTRAINT "budget_ledger_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"version_no" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"currency" text DEFAULT 'CNY' NOT NULL,
	"total_cents" bigint NOT NULL,
	"description" text,
	"status" "budget_status" DEFAULT 'draft' NOT NULL,
	"approval_instance_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "budgets_code_unique" UNIQUE("code"),
	CONSTRAINT "budgets_project_version_unique" UNIQUE("project_id","version_no")
);
--> statement-breakpoint
CREATE TABLE "expense_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_report_id" uuid NOT NULL,
	"code" text,
	"delta_cents" bigint NOT NULL,
	"reason" text NOT NULL,
	"approval_instance_id" uuid,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expense_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"expense_report_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"funding_request_id" uuid,
	"date" date NOT NULL,
	"category" "expense_category" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"description" text NOT NULL,
	"payee" text,
	"receipt_no" text,
	"receipt_file_version_id" uuid,
	"receipt_satisfied" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expense_items_amount_positive" CHECK ("amount_cents" > 0)
);
--> statement-breakpoint
CREATE TABLE "expense_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"applicant_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"is_cross_project" boolean DEFAULT false NOT NULL,
	"travel_id" uuid,
	"meeting_id" uuid,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"status" "expense_status" DEFAULT 'draft' NOT NULL,
	"approval_instance_id" uuid,
	"paid_at" timestamp with time zone,
	"paid_by" uuid,
	"payment_ref" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "expense_reports_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "funding_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"applicant_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"expected_use_date" date,
	"recipient_info" text,
	"source_meeting_id" uuid,
	"source_travel_id" uuid,
	"approval_status" text DEFAULT 'draft' NOT NULL,
	"usage_status" "funding_usage_status" DEFAULT 'unused' NOT NULL,
	"approval_instance_id" uuid,
	"closed_at" timestamp with time zone,
	"close_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "funding_requests_code_unique" UNIQUE("code"),
	CONSTRAINT "funding_requests_amount_positive" CHECK ("amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "budget_categories" ADD CONSTRAINT "budget_categories_budget_id_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."budgets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_ledger" ADD CONSTRAINT "budget_ledger_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_ledger" ADD CONSTRAINT "budget_ledger_budget_version_id_budgets_id_fk" FOREIGN KEY ("budget_version_id") REFERENCES "public"."budgets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_approval_instance_id_approval_instances_id_fk" FOREIGN KEY ("approval_instance_id") REFERENCES "public"."approval_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_adjustments" ADD CONSTRAINT "expense_adjustments_expense_report_id_expense_reports_id_fk" FOREIGN KEY ("expense_report_id") REFERENCES "public"."expense_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_adjustments" ADD CONSTRAINT "expense_adjustments_approval_instance_id_approval_instances_id_fk" FOREIGN KEY ("approval_instance_id") REFERENCES "public"."approval_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_adjustments" ADD CONSTRAINT "expense_adjustments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_adjustments" ADD CONSTRAINT "expense_adjustments_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_expense_report_id_expense_reports_id_fk" FOREIGN KEY ("expense_report_id") REFERENCES "public"."expense_reports"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_funding_request_id_funding_requests_id_fk" FOREIGN KEY ("funding_request_id") REFERENCES "public"."funding_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_receipt_file_version_id_file_versions_id_fk" FOREIGN KEY ("receipt_file_version_id") REFERENCES "public"."file_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_items" ADD CONSTRAINT "expense_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_applicant_id_users_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_travel_id_travel_requests_id_fk" FOREIGN KEY ("travel_id") REFERENCES "public"."travel_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_approval_instance_id_approval_instances_id_fk" FOREIGN KEY ("approval_instance_id") REFERENCES "public"."approval_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_paid_by_users_id_fk" FOREIGN KEY ("paid_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expense_reports" ADD CONSTRAINT "expense_reports_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_requests" ADD CONSTRAINT "funding_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_requests" ADD CONSTRAINT "funding_requests_applicant_id_users_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_requests" ADD CONSTRAINT "funding_requests_source_meeting_id_meetings_id_fk" FOREIGN KEY ("source_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_requests" ADD CONSTRAINT "funding_requests_source_travel_id_travel_requests_id_fk" FOREIGN KEY ("source_travel_id") REFERENCES "public"."travel_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_requests" ADD CONSTRAINT "funding_requests_approval_instance_id_approval_instances_id_fk" FOREIGN KEY ("approval_instance_id") REFERENCES "public"."approval_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_requests" ADD CONSTRAINT "funding_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_requests" ADD CONSTRAINT "funding_requests_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "budget_ledger_project_id_idx" ON "budget_ledger" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "budget_ledger_budget_version_id_idx" ON "budget_ledger" USING btree ("budget_version_id");--> statement-breakpoint
CREATE INDEX "budget_ledger_entry_type_idx" ON "budget_ledger" USING btree ("entry_type");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_active_unique" ON "budgets" USING btree ("project_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "budgets_project_id_idx" ON "budgets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "expense_adjustments_report_id_idx" ON "expense_adjustments" USING btree ("expense_report_id");--> statement-breakpoint
CREATE INDEX "expense_items_report_id_idx" ON "expense_items" USING btree ("expense_report_id");--> statement-breakpoint
CREATE INDEX "expense_items_project_id_idx" ON "expense_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "expense_reports_applicant_id_idx" ON "expense_reports" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX "expense_reports_status_idx" ON "expense_reports" USING btree ("status");--> statement-breakpoint
CREATE INDEX "funding_requests_project_id_idx" ON "funding_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "funding_requests_applicant_id_idx" ON "funding_requests" USING btree ("applicant_id");