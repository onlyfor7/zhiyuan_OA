CREATE TYPE "public"."flow_scope" AS ENUM('global', 'project');--> statement-breakpoint
CREATE TYPE "public"."generic_request_status" AS ENUM('draft', 'pending_approval', 'approved', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('registered', 'voided');--> statement-breakpoint
CREATE TABLE "flow_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scope" "flow_scope" DEFAULT 'global' NOT NULL,
	"biz_binding" text NOT NULL,
	"version_no" integer NOT NULL,
	"definition_json" jsonb NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "flow_definitions_name_version_unique" UNIQUE("name","version_no")
);
--> statement-breakpoint
CREATE TABLE "generic_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"request_type" text NOT NULL,
	"title" text NOT NULL,
	"reason" text NOT NULL,
	"start_on" date,
	"end_on" date,
	"amount_cents" bigint,
	"attachment_file_version_id" uuid,
	"applicant_id" uuid NOT NULL,
	"status" "generic_request_status" DEFAULT 'draft' NOT NULL,
	"approval_instance_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "generic_requests_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "payment_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"project_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"received_on" date NOT NULL,
	"reference_no" text NOT NULL,
	"payer_name" text,
	"note" text,
	"attachment_file_version_id" uuid,
	"status" "receipt_status" DEFAULT 'registered' NOT NULL,
	"void_reason" text,
	"voided_by" uuid,
	"voided_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "payment_receipts_code_unique" UNIQUE("code"),
	CONSTRAINT "payment_receipts_amount_positive" CHECK ("amount_cents" > 0)
);
--> statement-breakpoint
ALTER TABLE "flow_definitions" ADD CONSTRAINT "flow_definitions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_definitions" ADD CONSTRAINT "flow_definitions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generic_requests" ADD CONSTRAINT "generic_requests_attachment_file_version_id_file_versions_id_fk" FOREIGN KEY ("attachment_file_version_id") REFERENCES "public"."file_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generic_requests" ADD CONSTRAINT "generic_requests_applicant_id_users_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generic_requests" ADD CONSTRAINT "generic_requests_approval_instance_id_approval_instances_id_fk" FOREIGN KEY ("approval_instance_id") REFERENCES "public"."approval_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generic_requests" ADD CONSTRAINT "generic_requests_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generic_requests" ADD CONSTRAINT "generic_requests_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_attachment_file_version_id_file_versions_id_fk" FOREIGN KEY ("attachment_file_version_id") REFERENCES "public"."file_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_voided_by_users_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_receipts" ADD CONSTRAINT "payment_receipts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flow_definitions_enabled_unique" ON "flow_definitions" USING btree ("name") WHERE enabled = true;--> statement-breakpoint
CREATE INDEX "flow_definitions_biz_binding_idx" ON "flow_definitions" USING btree ("biz_binding");--> statement-breakpoint
CREATE INDEX "generic_requests_applicant_id_idx" ON "generic_requests" USING btree ("applicant_id");--> statement-breakpoint
CREATE INDEX "generic_requests_request_type_idx" ON "generic_requests" USING btree ("request_type");--> statement-breakpoint
CREATE INDEX "generic_requests_status_idx" ON "generic_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "payment_receipts_project_id_idx" ON "payment_receipts" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "payment_receipts_client_id_idx" ON "payment_receipts" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "payment_receipts_received_on_idx" ON "payment_receipts" USING btree ("received_on");