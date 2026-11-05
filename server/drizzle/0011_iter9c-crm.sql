CREATE TYPE "public"."contract_status" AS ENUM('draft', 'active', 'completed', 'terminated');--> statement-breakpoint
CREATE TYPE "public"."followup_target_type" AS ENUM('lead', 'opportunity', 'customer');--> statement-breakpoint
CREATE TYPE "public"."lead_status" AS ENUM('new', 'contacted', 'qualified', 'converted', 'disqualified');--> statement-breakpoint
CREATE TYPE "public"."opportunity_stage" AS ENUM('initial', 'needs', 'proposal', 'negotiation', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."payment_plan_status" AS ENUM('unpaid', 'partial', 'paid');--> statement-breakpoint
CREATE TABLE "crm_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"phone" text,
	"email" text,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_contract_payment_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"due_date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" "payment_plan_status" DEFAULT 'unpaid' NOT NULL,
	"receipt_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "crm_contract_payment_plans_contract_seq_unique" UNIQUE("contract_id","seq")
);
--> statement-breakpoint
CREATE TABLE "crm_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"opportunity_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"matter_id" uuid,
	"title" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"signed_at" timestamp with time zone,
	"status" "contract_status" DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "crm_contracts_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "crm_followups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "followup_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"content" text NOT NULL,
	"next_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"contact_name" text,
	"contact_phone" text,
	"status" "lead_status" DEFAULT 'new' NOT NULL,
	"owner_id" uuid,
	"disqualified_reason" text,
	"converted_customer_id" uuid,
	"converted_opportunity_id" uuid,
	"converted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "crm_leads_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "crm_opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"name" text NOT NULL,
	"stage" "opportunity_stage" DEFAULT 'initial' NOT NULL,
	"expected_amount_cents" bigint,
	"win_rate" integer,
	"owner_id" uuid,
	"won_contract_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "crm_opportunities_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "level" text DEFAULT '一般客户' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "industry" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "address" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "source_lead_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_customer_id_clients_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contacts" ADD CONSTRAINT "crm_contacts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contract_payment_plans" ADD CONSTRAINT "crm_contract_payment_plans_contract_id_crm_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."crm_contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contract_payment_plans" ADD CONSTRAINT "crm_contract_payment_plans_receipt_id_payment_receipts_id_fk" FOREIGN KEY ("receipt_id") REFERENCES "public"."payment_receipts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contract_payment_plans" ADD CONSTRAINT "crm_contract_payment_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contract_payment_plans" ADD CONSTRAINT "crm_contract_payment_plans_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contracts" ADD CONSTRAINT "crm_contracts_opportunity_id_crm_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."crm_opportunities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contracts" ADD CONSTRAINT "crm_contracts_customer_id_clients_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contracts" ADD CONSTRAINT "crm_contracts_matter_id_matters_id_fk" FOREIGN KEY ("matter_id") REFERENCES "public"."matters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contracts" ADD CONSTRAINT "crm_contracts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_contracts" ADD CONSTRAINT "crm_contracts_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_followups" ADD CONSTRAINT "crm_followups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_converted_customer_id_clients_id_fk" FOREIGN KEY ("converted_customer_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_converted_opportunity_id_crm_opportunities_id_fk" FOREIGN KEY ("converted_opportunity_id") REFERENCES "public"."crm_opportunities"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_leads" ADD CONSTRAINT "crm_leads_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_customer_id_clients_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_won_contract_id_crm_contracts_id_fk" FOREIGN KEY ("won_contract_id") REFERENCES "public"."crm_contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crm_contacts_customer_id_idx" ON "crm_contacts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "crm_contract_payment_plans_contract_id_idx" ON "crm_contract_payment_plans" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "crm_contracts_customer_id_idx" ON "crm_contracts" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "crm_contracts_opportunity_id_idx" ON "crm_contracts" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "crm_followups_target_idx" ON "crm_followups" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "crm_leads_status_idx" ON "crm_leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "crm_leads_owner_id_idx" ON "crm_leads" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "crm_opportunities_customer_id_idx" ON "crm_opportunities" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "crm_opportunities_stage_idx" ON "crm_opportunities" USING btree ("stage");--> statement-breakpoint
ALTER TABLE "clients" ADD CONSTRAINT "clients_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;