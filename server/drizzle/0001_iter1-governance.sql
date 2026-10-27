CREATE TYPE "public"."approval_instance_status" AS ENUM('pending', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."approval_step_status" AS ENUM('pending', 'approved', 'rejected', 'transferred', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."change_level" AS ENUM('normal', 'key');--> statement-breakpoint
CREATE TYPE "public"."change_request_status" AS ENUM('draft', 'pending_approval', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."check_item_status" AS ENUM('pending', 'passed', 'failed', 'waived');--> statement-breakpoint
CREATE TYPE "public"."countersign_rule" AS ENUM('any', 'all');--> statement-breakpoint
CREATE TYPE "public"."decision_status" AS ENUM('draft', 'deciding', 'decided', 'verified');--> statement-breakpoint
CREATE TYPE "public"."deliverable_status" AS ENUM('pending', 'delivered', 'accepted');--> statement-breakpoint
CREATE TYPE "public"."milestone_status" AS ENUM('pending', 'reached', 'missed');--> statement-breakpoint
CREATE TYPE "public"."plan_item_type" AS ENUM('stage', 'milestone', 'task');--> statement-breakpoint
CREATE TYPE "public"."plan_version_kind" AS ENUM('baseline', 'change');--> statement-breakpoint
CREATE TYPE "public"."plan_version_status" AS ENUM('active', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."quality_event_action" AS ENUM('create', 'assign', 'handle_submit', 'review_pass', 'review_return', 'reopen');--> statement-breakpoint
CREATE TYPE "public"."quality_issue_status" AS ENUM('open', 'handling', 'pending_review', 'closed');--> statement-breakpoint
CREATE TYPE "public"."quality_severity" AS ENUM('critical', 'severe', 'major', 'minor');--> statement-breakpoint
CREATE TYPE "public"."stage_status" AS ENUM('pending', 'active', 'done');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('pending', 'in_progress', 'done', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."weekly_report_status" AS ENUM('draft', 'confirmed', 'archived');--> statement-breakpoint
CREATE TABLE "approval_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"biz_type" text NOT NULL,
	"biz_id" uuid NOT NULL,
	"project_id" uuid,
	"applicant_id" uuid NOT NULL,
	"form_snapshot" jsonb NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"current_step_seq" integer DEFAULT 1 NOT NULL,
	"status" "approval_instance_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "approval_instances_code_unique" UNIQUE("code"),
	CONSTRAINT "approval_instances_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "approval_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"biz_type" text NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"match_json" jsonb NOT NULL,
	"steps_json" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"approver_id" uuid,
	"approver_role" text,
	"countersign" "countersign_rule" DEFAULT 'any' NOT NULL,
	"status" "approval_step_status" DEFAULT 'pending' NOT NULL,
	"acted_by" uuid,
	"comment" text,
	"acted_at" timestamp with time zone,
	"delegated_from" uuid,
	CONSTRAINT "approval_steps_instance_seq_unique" UNIQUE("instance_id","seq")
);
--> statement-breakpoint
CREATE TABLE "archive_directories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"dir_key" text NOT NULL,
	"name" text NOT NULL,
	"seq" integer NOT NULL,
	CONSTRAINT "archive_directories_project_key_unique" UNIQUE("project_id","dir_key")
);
--> statement-breakpoint
CREATE TABLE "archive_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"directory_id" uuid NOT NULL,
	"file_version_id" uuid,
	"source_type" text,
	"source_id" uuid,
	"business_date" date,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "archive_links_source_unique" UNIQUE("directory_id","source_type","source_id"),
	CONSTRAINT "archive_links_duality_check" CHECK ((("file_version_id" is not null and "source_type" is not null and "source_type" <> 'report' and "source_id" is not null)
        or ("file_version_id" is null and "source_type" = 'report' and "source_id" is not null)))
);
--> statement-breakpoint
CREATE TABLE "change_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"target_items" jsonb NOT NULL,
	"reason" text NOT NULL,
	"impact" text NOT NULL,
	"recovery_measures" jsonb NOT NULL,
	"level" "change_level" DEFAULT 'normal' NOT NULL,
	"status" "change_request_status" DEFAULT 'draft' NOT NULL,
	"approval_instance_id" uuid,
	"resulting_plan_version_id" uuid,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "change_requests_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"context" text NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pm_opinion" text,
	"quality_opinion" text,
	"final_option" text,
	"final_reason" text,
	"conditions" text,
	"checkpoints" jsonb,
	"status" "decision_status" DEFAULT 'draft' NOT NULL,
	"decider_id" uuid,
	"decided_at" timestamp with time zone,
	"verification_note" text,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "decisions_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "deliverables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"milestone_id" uuid,
	"task_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"status" "deliverable_status" DEFAULT 'pending' NOT NULL,
	"file_version_id" uuid,
	"delivered_at" timestamp with time zone,
	"delivered_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "deliverables_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "milestones" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"stage_id" uuid,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"seq" integer NOT NULL,
	"planned_date" date NOT NULL,
	"actual_date" date,
	"status" "milestone_status" DEFAULT 'pending' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "milestones_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_version_id" uuid NOT NULL,
	"item_type" "plan_item_type" NOT NULL,
	"ref_id" uuid NOT NULL,
	"planned_start" date NOT NULL,
	"planned_end" date NOT NULL,
	"seq" integer NOT NULL,
	"depends_on" uuid[] DEFAULT '{}' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"kind" "plan_version_kind" NOT NULL,
	"status" "plan_version_status" DEFAULT 'active' NOT NULL,
	"source_change_request_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_versions_project_version_unique" UNIQUE("project_id","version_no")
);
--> statement-breakpoint
CREATE TABLE "project_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"structure_json" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_templates_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "quality_check_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"stage_id" uuid,
	"name" text NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"status" "check_item_status" DEFAULT 'pending' NOT NULL,
	"checked_by" uuid,
	"checked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_issue_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issue_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" "quality_event_action" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"severity" "quality_severity" NOT NULL,
	"status" "quality_issue_status" DEFAULT 'open' NOT NULL,
	"reporter_id" uuid NOT NULL,
	"handler_id" uuid,
	"reviewer_id" uuid,
	"root_cause" text,
	"source_type" text,
	"source_id" uuid,
	"is_blocking" boolean DEFAULT false NOT NULL,
	"closed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "quality_issues_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"seq" integer NOT NULL,
	"planned_start" date NOT NULL,
	"planned_end" date NOT NULL,
	"actual_start" date,
	"actual_end" date,
	"status" "stage_status" DEFAULT 'pending' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "stages_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"stage_id" uuid,
	"milestone_id" uuid,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"assignee_id" uuid,
	"planned_start" date NOT NULL,
	"planned_end" date NOT NULL,
	"actual_start" timestamp with time zone,
	"actual_end" timestamp with time zone,
	"status" "task_status" DEFAULT 'pending' NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"completed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "tasks_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "weekly_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"version_no" integer DEFAULT 1 NOT NULL,
	"status" "weekly_report_status" DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "weekly_reports_code_unique" UNIQUE("code"),
	CONSTRAINT "weekly_reports_period_version_unique" UNIQUE("project_id","period_start","version_no")
);
--> statement-breakpoint
ALTER TABLE "file_objects" ADD COLUMN "source_type" text;--> statement-breakpoint
ALTER TABLE "file_objects" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "file_versions" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_applicant_id_users_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_instances" ADD CONSTRAINT "approval_instances_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_policies" ADD CONSTRAINT "approval_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_instance_id_approval_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."approval_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_acted_by_users_id_fk" FOREIGN KEY ("acted_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_steps" ADD CONSTRAINT "approval_steps_delegated_from_users_id_fk" FOREIGN KEY ("delegated_from") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_directories" ADD CONSTRAINT "archive_directories_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_links" ADD CONSTRAINT "archive_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_links" ADD CONSTRAINT "archive_links_directory_id_archive_directories_id_fk" FOREIGN KEY ("directory_id") REFERENCES "public"."archive_directories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_links" ADD CONSTRAINT "archive_links_file_version_id_file_versions_id_fk" FOREIGN KEY ("file_version_id") REFERENCES "public"."file_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "archive_links" ADD CONSTRAINT "archive_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_approval_instance_id_approval_instances_id_fk" FOREIGN KEY ("approval_instance_id") REFERENCES "public"."approval_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_resulting_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("resulting_plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_requests" ADD CONSTRAINT "change_requests_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_decider_id_users_id_fk" FOREIGN KEY ("decider_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_file_version_id_file_versions_id_fk" FOREIGN KEY ("file_version_id") REFERENCES "public"."file_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_delivered_by_users_id_fk" FOREIGN KEY ("delivered_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_stage_id_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_plan_version_id_plan_versions_id_fk" FOREIGN KEY ("plan_version_id") REFERENCES "public"."plan_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_items" ADD CONSTRAINT "plan_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_source_change_request_id_change_requests_id_fk" FOREIGN KEY ("source_change_request_id") REFERENCES "public"."change_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_versions" ADD CONSTRAINT "plan_versions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_templates" ADD CONSTRAINT "project_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_templates" ADD CONSTRAINT "project_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_check_items" ADD CONSTRAINT "quality_check_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_check_items" ADD CONSTRAINT "quality_check_items_stage_id_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_check_items" ADD CONSTRAINT "quality_check_items_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_check_items" ADD CONSTRAINT "quality_check_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_check_items" ADD CONSTRAINT "quality_check_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_issue_events" ADD CONSTRAINT "quality_issue_events_issue_id_quality_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."quality_issues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_issue_events" ADD CONSTRAINT "quality_issue_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_handler_id_users_id_fk" FOREIGN KEY ("handler_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_issues" ADD CONSTRAINT "quality_issues_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stages" ADD CONSTRAINT "stages_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_stage_id_stages_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."stages"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_milestone_id_milestones_id_fk" FOREIGN KEY ("milestone_id") REFERENCES "public"."milestones"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_reports" ADD CONSTRAINT "weekly_reports_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_instances_applicant_id_idx" ON "approval_instances" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX "approval_policies_biz_type_idx" ON "approval_policies" USING btree ("biz_type");--> statement-breakpoint
CREATE UNIQUE INDEX "archive_links_file_unique" ON "archive_links" USING btree ("directory_id","file_version_id") WHERE file_version_id is not null;--> statement-breakpoint
CREATE INDEX "archive_links_directory_id_idx" ON "archive_links" USING btree ("directory_id");--> statement-breakpoint
CREATE INDEX "change_requests_project_id_idx" ON "change_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "decisions_project_id_idx" ON "decisions" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "deliverables_project_id_idx" ON "deliverables" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "milestones_project_id_idx" ON "milestones" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "milestones_stage_id_idx" ON "milestones" USING btree ("stage_id");--> statement-breakpoint
CREATE INDEX "plan_items_plan_version_id_idx" ON "plan_items" USING btree ("plan_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_versions_active_unique" ON "plan_versions" USING btree ("project_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "quality_check_items_project_id_idx" ON "quality_check_items" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "quality_issue_events_issue_id_idx" ON "quality_issue_events" USING btree ("issue_id");--> statement-breakpoint
CREATE INDEX "quality_issues_project_id_idx" ON "quality_issues" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "stages_project_id_idx" ON "stages" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tasks_project_id_idx" ON "tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_id_idx" ON "tasks" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "file_objects_source_idx" ON "file_objects" USING btree ("source_type","source_id");--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_idempotency_key_unique" UNIQUE("idempotency_key");