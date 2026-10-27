CREATE TYPE "public"."action_item_status" AS ENUM('open', 'converted');--> statement-breakpoint
CREATE TYPE "public"."attendance_status" AS ENUM('planned', 'attended', 'absent', 'excused');--> statement-breakpoint
CREATE TYPE "public"."meeting_status" AS ENUM('planned', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."meeting_type" AS ENUM('project', 'client', 'quality_review', 'weekly', 'decision');--> statement-breakpoint
CREATE TYPE "public"."minutes_status" AS ENUM('none_required', 'pending_draft', 'pending_confirm', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."participant_role" AS ENUM('required', 'optional');--> statement-breakpoint
CREATE TYPE "public"."segment_type" AS ENUM('transport', 'accommodation', 'client_site', 'other');--> statement-breakpoint
CREATE TYPE "public"."travel_event_action" AS ENUM('create', 'submit', 'approve', 'reject', 'withdraw', 'change_submit', 'change_approved', 'depart', 'complete', 'close', 'cancel');--> statement-breakpoint
CREATE TYPE "public"."travel_status" AS ENUM('draft', 'pending_approval', 'approved', 'rejected', 'in_progress', 'completed', 'closed', 'cancelled');--> statement-breakpoint
ALTER TYPE "public"."access_grant_status" ADD VALUE 'rejected';--> statement-breakpoint
CREATE TABLE "meeting_action_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"minutes_version_id" uuid,
	"title" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"due_date" date NOT NULL,
	"deliverable" text,
	"checkpoint" text,
	"status" "action_item_status" DEFAULT 'open' NOT NULL,
	"converted_task_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meeting_minutes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"body" text NOT NULL,
	"disagreements" text,
	"risks" text,
	"recorder_id" uuid NOT NULL,
	"confirmer_id" uuid,
	"confirmed_at" timestamp with time zone,
	"file_version_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "meeting_minutes_version_unique" UNIQUE("meeting_id","version_no")
);
--> statement-breakpoint
CREATE TABLE "meeting_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"meeting_id" uuid NOT NULL,
	"user_id" uuid,
	"external_name" text,
	"external_org" text,
	"role" "participant_role" DEFAULT 'required' NOT NULL,
	"attendance" "attendance_status" DEFAULT 'planned' NOT NULL,
	"notify_contact" text,
	CONSTRAINT "meeting_participants_duality_check" CHECK ((("user_id" is not null and "external_name" is null) or ("user_id" is null and "external_name" is not null)))
);
--> statement-breakpoint
CREATE TABLE "meetings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"type" "meeting_type" NOT NULL,
	"subject" text NOT NULL,
	"agenda" text,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"location" text,
	"online_url" text,
	"organizer_id" uuid NOT NULL,
	"recorder_id" uuid,
	"confidentiality_level" "confidentiality_level" DEFAULT 'internal' NOT NULL,
	"status" "meeting_status" DEFAULT 'planned' NOT NULL,
	"minutes_status" "minutes_status" DEFAULT 'pending_draft' NOT NULL,
	"cancel_reason" text,
	"actual_start_at" timestamp with time zone,
	"actual_end_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "meetings_code_unique" UNIQUE("code"),
	CONSTRAINT "meetings_time_check" CHECK ("end_at" > "start_at")
);
--> statement-breakpoint
CREATE TABLE "travel_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"travel_request_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" "travel_event_action" NOT NULL,
	"payload_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"applicant_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"destination" text NOT NULL,
	"start_on" date NOT NULL,
	"end_on" date NOT NULL,
	"estimated_cost_cents" bigint,
	"borrow" boolean DEFAULT false NOT NULL,
	"borrow_amount_cents" bigint,
	"status" "travel_status" DEFAULT 'draft' NOT NULL,
	"approval_instance_id" uuid,
	"completion_summary" text,
	"actual_cost_note" text,
	"completed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "travel_requests_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "travel_segments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"travel_request_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" "segment_type" NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"from_place" text,
	"to_place" text,
	"description" text,
	"linked_meeting_id" uuid,
	"linked_task_id" uuid
);
--> statement-breakpoint
ALTER TABLE "archive_links" DROP CONSTRAINT "archive_links_duality_check";--> statement-breakpoint
ALTER TABLE "approval_steps" ADD COLUMN "acted_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_minutes_version_id_meeting_minutes_id_fk" FOREIGN KEY ("minutes_version_id") REFERENCES "public"."meeting_minutes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_converted_task_id_tasks_id_fk" FOREIGN KEY ("converted_task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_action_items" ADD CONSTRAINT "meeting_action_items_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_recorder_id_users_id_fk" FOREIGN KEY ("recorder_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_confirmer_id_users_id_fk" FOREIGN KEY ("confirmer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_file_version_id_file_versions_id_fk" FOREIGN KEY ("file_version_id") REFERENCES "public"."file_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_minutes" ADD CONSTRAINT "meeting_minutes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meeting_id_meetings_id_fk" FOREIGN KEY ("meeting_id") REFERENCES "public"."meetings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_organizer_id_users_id_fk" FOREIGN KEY ("organizer_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_recorder_id_users_id_fk" FOREIGN KEY ("recorder_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_events" ADD CONSTRAINT "travel_events_travel_request_id_travel_requests_id_fk" FOREIGN KEY ("travel_request_id") REFERENCES "public"."travel_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_events" ADD CONSTRAINT "travel_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_applicant_id_users_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_approval_instance_id_approval_instances_id_fk" FOREIGN KEY ("approval_instance_id") REFERENCES "public"."approval_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_requests" ADD CONSTRAINT "travel_requests_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_segments" ADD CONSTRAINT "travel_segments_travel_request_id_travel_requests_id_fk" FOREIGN KEY ("travel_request_id") REFERENCES "public"."travel_requests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_segments" ADD CONSTRAINT "travel_segments_linked_meeting_id_meetings_id_fk" FOREIGN KEY ("linked_meeting_id") REFERENCES "public"."meetings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_segments" ADD CONSTRAINT "travel_segments_linked_task_id_tasks_id_fk" FOREIGN KEY ("linked_task_id") REFERENCES "public"."tasks"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "meeting_action_items_meeting_id_idx" ON "meeting_action_items" USING btree ("meeting_id");--> statement-breakpoint
CREATE UNIQUE INDEX "meeting_participants_user_unique" ON "meeting_participants" USING btree ("meeting_id","user_id") WHERE user_id is not null;--> statement-breakpoint
CREATE INDEX "meeting_participants_meeting_id_idx" ON "meeting_participants" USING btree ("meeting_id");--> statement-breakpoint
CREATE INDEX "meetings_project_id_idx" ON "meetings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "meetings_status_idx" ON "meetings" USING btree ("status");--> statement-breakpoint
CREATE INDEX "travel_events_travel_request_id_idx" ON "travel_events" USING btree ("travel_request_id");--> statement-breakpoint
CREATE INDEX "travel_requests_project_id_idx" ON "travel_requests" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "travel_requests_applicant_id_idx" ON "travel_requests" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX "travel_requests_status_idx" ON "travel_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "travel_segments_travel_request_id_idx" ON "travel_segments" USING btree ("travel_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_aggregate_unique" ON "notifications" USING btree ("recipient_id","aggregate_key") WHERE aggregate_key is not null;--> statement-breakpoint
ALTER TABLE "archive_links" ADD CONSTRAINT "archive_links_duality_check" CHECK ((("file_version_id" is not null and "source_type" is not null and "source_type" <> 'report' and "source_id" is not null)
        or ("file_version_id" is null and "source_type" in ('report', 'meeting', 'travel') and "source_id" is not null)));