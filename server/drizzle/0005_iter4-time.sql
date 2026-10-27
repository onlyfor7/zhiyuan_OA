CREATE TYPE "public"."time_activity_type" AS ENUM('professional_work', 'meeting', 'travel', 'quality_review', 'internal_admin', 'other');--> statement-breakpoint
CREATE TYPE "public"."time_entry_source" AS ENUM('manual', 'prefill_meeting', 'prefill_travel', 'copy');--> statement-breakpoint
CREATE TYPE "public"."timesheet_status" AS ENUM('draft', 'pending_approval', 'approved', 'returned', 'locked');--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"task_id" uuid,
	"meeting_id" uuid,
	"travel_id" uuid,
	"activity_type" time_activity_type NOT NULL,
	"work_date" date NOT NULL,
	"duration_minutes" integer NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"billable" boolean DEFAULT true NOT NULL,
	"source" time_entry_source DEFAULT 'manual' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "time_entries_duration_positive" CHECK ("duration_minutes" > 0),
	CONSTRAINT "time_entries_nonproject_activity_check" CHECK (("project_id" is not null or "activity_type" in ('internal_admin', 'other')))
);
--> statement-breakpoint
CREATE TABLE "timesheet_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"user_id" uuid NOT NULL,
	"period_type" text DEFAULT 'weekly' NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"status" timesheet_status DEFAULT 'draft' NOT NULL,
	"approver_id" uuid,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"returned_note" text,
	"locked_at" timestamp with time zone,
	"locked_by" uuid,
	"lock_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "timesheet_periods_code_unique" UNIQUE("code"),
	CONSTRAINT "timesheet_periods_user_start_unique" UNIQUE("user_id","period_start")
);
--> statement-breakpoint
ALTER TABLE "archive_links" DROP CONSTRAINT "archive_links_duality_check";--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_period_id_timesheet_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."timesheet_periods"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_travel_id_travel_requests_id_fk" FOREIGN KEY ("travel_id") REFERENCES "public"."travel_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timesheet_periods" ADD CONSTRAINT "timesheet_periods_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_entries_user_work_date_idx" ON "time_entries" USING btree ("user_id","work_date");--> statement-breakpoint
CREATE INDEX "time_entries_project_work_date_idx" ON "time_entries" USING btree ("project_id","work_date");--> statement-breakpoint
CREATE INDEX "time_entries_period_id_idx" ON "time_entries" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "timesheet_periods_user_id_idx" ON "timesheet_periods" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "timesheet_periods_status_idx" ON "timesheet_periods" USING btree ("status");--> statement-breakpoint
ALTER TABLE "archive_links" ADD CONSTRAINT "archive_links_duality_check" CHECK ((("file_version_id" is not null and "source_type" is not null and "source_type" <> 'report' and "source_id" is not null)
        or ("file_version_id" is null and "source_type" in ('report', 'meeting', 'travel', 'funding', 'expense') and "source_id" is not null)));