CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'issued', 'sent', 'voided');--> statement-breakpoint
CREATE TYPE "public"."receivable_status" AS ENUM('open', 'partial', 'settled');--> statement-breakpoint
CREATE TABLE "fin_cost_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"role" text,
	"hourly_rate_cents" bigint NOT NULL,
	"effective_from" date NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fin_cost_rates_duality_check" CHECK ((("user_id" is null and "role" is not null) or ("user_id" is not null and "role" is null)))
);
--> statement-breakpoint
CREATE TABLE "fin_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"customer_id" uuid NOT NULL,
	"contract_id" uuid,
	"receivable_id" uuid,
	"amount_cents" bigint NOT NULL,
	"tax_rate" integer DEFAULT 0 NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"issued_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "fin_invoices_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "fin_receivables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"contract_id" uuid NOT NULL,
	"plan_id" uuid,
	"customer_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"due_date" date NOT NULL,
	"status" "receivable_status" DEFAULT 'open' NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "fin_receivables_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "fin_cost_rates" ADD CONSTRAINT "fin_cost_rates_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_cost_rates" ADD CONSTRAINT "fin_cost_rates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_cost_rates" ADD CONSTRAINT "fin_cost_rates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_invoices" ADD CONSTRAINT "fin_invoices_customer_id_clients_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_invoices" ADD CONSTRAINT "fin_invoices_contract_id_crm_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."crm_contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_invoices" ADD CONSTRAINT "fin_invoices_receivable_id_fin_receivables_id_fk" FOREIGN KEY ("receivable_id") REFERENCES "public"."fin_receivables"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_invoices" ADD CONSTRAINT "fin_invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_invoices" ADD CONSTRAINT "fin_invoices_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_receivables" ADD CONSTRAINT "fin_receivables_contract_id_crm_contracts_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."crm_contracts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_receivables" ADD CONSTRAINT "fin_receivables_plan_id_crm_contract_payment_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."crm_contract_payment_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_receivables" ADD CONSTRAINT "fin_receivables_customer_id_clients_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."clients"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_receivables" ADD CONSTRAINT "fin_receivables_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fin_receivables" ADD CONSTRAINT "fin_receivables_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fin_cost_rates_user_id_idx" ON "fin_cost_rates" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "fin_invoices_customer_id_idx" ON "fin_invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "fin_invoices_receivable_id_idx" ON "fin_invoices" USING btree ("receivable_id");--> statement-breakpoint
CREATE INDEX "fin_receivables_contract_id_idx" ON "fin_receivables" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "fin_receivables_customer_id_idx" ON "fin_receivables" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "fin_receivables_due_date_idx" ON "fin_receivables" USING btree ("due_date");