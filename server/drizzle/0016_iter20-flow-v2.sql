CREATE TYPE "public"."custom_form_status" AS ENUM('draft', 'published', 'disabled');--> statement-breakpoint
CREATE TABLE "custom_form_defs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text,
	"group_name" text DEFAULT '通用' NOT NULL,
	"visibility" jsonb NOT NULL,
	"form_schema" jsonb NOT NULL,
	"form_version" integer DEFAULT 1 NOT NULL,
	"flow_id" uuid,
	"status" "custom_form_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "custom_form_defs_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "flow_definitions" ADD COLUMN "definition_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "generic_requests" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "generic_requests" ADD COLUMN "form_id" uuid;--> statement-breakpoint
ALTER TABLE "generic_requests" ADD COLUMN "form_version" integer;--> statement-breakpoint
ALTER TABLE "custom_form_defs" ADD CONSTRAINT "custom_form_defs_flow_id_flow_definitions_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flow_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_form_defs" ADD CONSTRAINT "custom_form_defs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_form_defs" ADD CONSTRAINT "custom_form_defs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "custom_form_defs_flow_id_unique" ON "custom_form_defs" USING btree ("flow_id") WHERE flow_id is not null;--> statement-breakpoint
CREATE INDEX "custom_form_defs_status_idx" ON "custom_form_defs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "custom_form_defs_group_name_idx" ON "custom_form_defs" USING btree ("group_name");--> statement-breakpoint
ALTER TABLE "generic_requests" ADD CONSTRAINT "generic_requests_form_id_custom_form_defs_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."custom_form_defs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generic_requests_form_id_idx" ON "generic_requests" USING btree ("form_id");