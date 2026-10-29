DROP INDEX "flow_definitions_enabled_unique";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "must_change_password" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "matters" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "flow_definitions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "flow_definitions" ADD CONSTRAINT "flow_definitions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flow_definitions_enabled_unique" ON "flow_definitions" USING btree ("biz_binding",coalesce("project_id", '00000000-0000-0000-0000-000000000000')) WHERE enabled = true;--> statement-breakpoint
-- 02b 存量回填：system_config 暂存的停用清单/首登改密标记迁移到实体行（裁定：实体生命周期状态必须在行上，禁再存 system_config）
UPDATE "public"."clients" SET "status" = 'disabled'
WHERE EXISTS (
  SELECT 1 FROM "public"."system_config"
  WHERE "key" = 'admin.disabled_clients' AND "value_json" @> jsonb_build_array("clients"."id"::text)
);--> statement-breakpoint
UPDATE "public"."matters" SET "status" = 'disabled'
WHERE EXISTS (
  SELECT 1 FROM "public"."system_config"
  WHERE "key" = 'admin.disabled_matters' AND "value_json" @> jsonb_build_array("matters"."id"::text)
);--> statement-breakpoint
UPDATE "public"."users" SET "must_change_password" = true
WHERE EXISTS (
  SELECT 1 FROM "public"."system_config"
  WHERE "key" = 'auth.must_change_password' AND "value_json" -> "users"."id"::text = 'true'::jsonb
);--> statement-breakpoint
DELETE FROM "public"."system_config" WHERE "key" IN ('admin.disabled_clients', 'admin.disabled_matters', 'auth.must_change_password');
