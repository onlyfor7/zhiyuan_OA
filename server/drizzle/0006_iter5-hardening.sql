ALTER TABLE "time_entries" ADD COLUMN "start_minute" integer;--> statement-breakpoint
ALTER TABLE "time_entries" ADD COLUMN "end_minute" integer;--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_start_minute_check" CHECK ("start_minute" is null or ("start_minute" >= 0 and "start_minute" <= 1439));--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_end_minute_check" CHECK ("end_minute" is null or ("end_minute" >= 1 and "end_minute" <= 1440));--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_minute_order_check" CHECK ("start_minute" is null or "end_minute" is null or "end_minute" > "start_minute");--> statement-breakpoint
DROP TRIGGER IF EXISTS "audit_events_append_only_trigger" ON "public"."audit_events";
--> statement-breakpoint
DROP TRIGGER IF EXISTS "budget_ledger_append_only_trigger" ON "public"."budget_ledger";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."lexflow_append_only_guard"() RETURNS trigger AS $guard$
BEGIN
  RAISE EXCEPTION 'lexflow: % is append-only, UPDATE/DELETE is forbidden (arch/00 §3.9, arch/08 §6)', TG_TABLE_NAME;
END;
$guard$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "audit_events_append_only_trigger" BEFORE UPDATE OR DELETE ON "public"."audit_events" FOR EACH ROW EXECUTE FUNCTION "public"."lexflow_append_only_guard"();
--> statement-breakpoint
CREATE TRIGGER "budget_ledger_append_only_trigger" BEFORE UPDATE OR DELETE ON "public"."budget_ledger" FOR EACH ROW EXECUTE FUNCTION "public"."lexflow_append_only_guard"();