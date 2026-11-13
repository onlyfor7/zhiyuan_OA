ALTER TABLE "crm_leads" ALTER COLUMN "code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "manager_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD COLUMN "source_lead_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD COLUMN "presales_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD COLUMN "closed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_source_lead_id_crm_leads_id_fk" FOREIGN KEY ("source_lead_id") REFERENCES "public"."crm_leads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_presales_id_users_id_fk" FOREIGN KEY ("presales_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crm_opportunities" ADD CONSTRAINT "crm_opportunities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_manager_id_idx" ON "users" USING btree ("manager_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crm_opportunities_project_id_unique" ON "crm_opportunities" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "crm_opportunities_source_lead_id_idx" ON "crm_opportunities" USING btree ("source_lead_id");--> statement-breakpoint
CREATE INDEX "crm_opportunities_presales_id_idx" ON "crm_opportunities" USING btree ("presales_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_manager_not_self" CHECK ("users"."manager_id" is null or "users"."manager_id" <> "users"."id");--> statement-breakpoint
-- ===== 迭代 18 工单 01：存量商机项目补齐（arch/13 §5.3 D5；工单 01 §5） =====
-- 规则：① 能通过赢单合同/事项唯一确认既有项目的只补关联（禁止新建）；② 无法唯一确认的同事务建事项+项目；
-- ③ 生命周期：开放→preparing、won 且有 active 合同→in_progress、lost→closed；
-- ④ 成员补 manager + 商机 owner；⑤ lost 的 closed_reason/closed_at 优先 markLost 审计快照，无快照用统一文案。
-- 幂等：只处理 project_id 为空或 lost 未落关闭时间的商机；唯一约束兜底；异常计数非零即整体失败，不静默跳过。
CREATE OR REPLACE FUNCTION "public"."crm_backfill_opportunity_projects"()
RETURNS TABLE(processed integer, reused integer, created integer, lost_backfilled integer, lost_fallback integer, anomalies integer)
LANGUAGE plpgsql
AS $func$
DECLARE
  rec RECORD;
  v_matter_id uuid;
  v_project_id uuid;
  v_project_cnt integer;
  v_actor uuid;
  v_manager uuid;
  v_year integer := extract(year from now())::integer;
  v_seq integer;
  v_has_active_contract boolean;
  v_lifecycle text;
  v_audit_reason text;
  v_audit_at timestamptz;
  v_processed integer := 0;
  v_reused integer := 0;
  v_created integer := 0;
  v_lost_backfilled integer := 0;
  v_lost_fallback integer := 0;
  v_anomalies integer := 0;
BEGIN
  FOR rec IN
    SELECT o.* FROM "public"."crm_opportunities" o
    WHERE o."project_id" IS NULL OR (o."stage" = 'lost' AND o."closed_at" IS NULL)
    ORDER BY o."created_at", o."id"
  LOOP
    v_processed := v_processed + 1;
    v_project_id := rec."project_id";

    -- ① 赢单合同/事项唯一确认既有项目 → 补关联，禁止新建
    IF v_project_id IS NULL AND rec."won_contract_id" IS NOT NULL THEN
      SELECT c."matter_id" INTO v_matter_id FROM "public"."crm_contracts" c WHERE c."id" = rec."won_contract_id";
      IF v_matter_id IS NOT NULL THEN
        SELECT count(*)::integer INTO v_project_cnt FROM "public"."projects" p WHERE p."matter_id" = v_matter_id;
        IF v_project_cnt = 1 THEN
          SELECT p."id" INTO v_project_id FROM "public"."projects" p WHERE p."matter_id" = v_matter_id;
        ELSE
          v_project_id := NULL;
        END IF;
      END IF;
      IF v_project_id IS NOT NULL THEN
        UPDATE "public"."crm_opportunities" SET "project_id" = v_project_id, "updated_at" = now() WHERE "id" = rec."id";
        v_reused := v_reused + 1;
      END IF;
    END IF;

    -- ② 无法唯一确认 → 同事务创建客户业务事项与项目（编号走既有序列规则），再补关联
    IF v_project_id IS NULL THEN
      v_actor := coalesce(rec."owner_id", rec."created_by", rec."updated_by");
      IF v_actor IS NULL THEN
        SELECT u."id" INTO v_actor FROM "public"."users" u WHERE u."status" = 'active' ORDER BY u."created_at", u."id" LIMIT 1;
      END IF;
      IF v_actor IS NULL THEN
        RAISE EXCEPTION '18-01 补齐失败：商机 % 无可用操作人', rec."code";
      END IF;
      -- 项目负责人：无"可唯一确认的既有项目负责人"（此分支即无既有项目）→ 取商机负责人
      v_manager := coalesce(rec."owner_id", v_actor);

      INSERT INTO "public"."code_sequences" ("prefix", "year", "next_value") VALUES ('MTR', v_year, 1)
        ON CONFLICT ("prefix", "year") DO UPDATE SET "next_value" = "code_sequences"."next_value" + 1
        RETURNING "next_value" INTO v_seq;
      INSERT INTO "public"."matters" ("code", "client_id", "name", "type", "created_by", "updated_by")
        VALUES ('MTR-' || v_year::text || '-' || lpad(v_seq::text, 5, '0'), rec."customer_id", rec."name", '售前', v_actor, v_actor)
        RETURNING "id" INTO v_matter_id;

      INSERT INTO "public"."code_sequences" ("prefix", "year", "next_value") VALUES ('PRJ', v_year, 1)
        ON CONFLICT ("prefix", "year") DO UPDATE SET "next_value" = "code_sequences"."next_value" + 1
        RETURNING "next_value" INTO v_seq;
      SELECT EXISTS (
        SELECT 1 FROM "public"."crm_contracts" c WHERE c."opportunity_id" = rec."id" AND c."status" = 'active'
      ) INTO v_has_active_contract;
      v_lifecycle := CASE
        WHEN rec."stage" = 'lost' THEN 'closed'
        WHEN rec."stage" = 'won' AND v_has_active_contract THEN 'in_progress'
        ELSE 'preparing'
      END;
      INSERT INTO "public"."projects" ("code", "matter_id", "name", "type", "manager_id", "lifecycle_status", "created_by", "updated_by")
        VALUES ('PRJ-' || v_year::text || '-' || lpad(v_seq::text, 5, '0'), v_matter_id, rec."name" || '项目', '售前', v_manager, v_lifecycle::"project_lifecycle_status", v_actor, v_actor)
        RETURNING "id" INTO v_project_id;
      UPDATE "public"."crm_opportunities" SET "project_id" = v_project_id, "updated_at" = now() WHERE "id" = rec."id";
      v_created := v_created + 1;
    END IF;

    -- ③ 生命周期对齐（含复用既有项目的路径）
    SELECT EXISTS (
      SELECT 1 FROM "public"."crm_contracts" c WHERE c."opportunity_id" = rec."id" AND c."status" = 'active'
    ) INTO v_has_active_contract;
    IF rec."stage" = 'lost' THEN
      UPDATE "public"."projects" SET "lifecycle_status" = 'closed', "updated_at" = now()
        WHERE "id" = v_project_id AND "lifecycle_status" <> 'closed';
    ELSIF rec."stage" = 'won' AND v_has_active_contract THEN
      UPDATE "public"."projects" SET "lifecycle_status" = 'in_progress', "updated_at" = now()
        WHERE "id" = v_project_id AND "lifecycle_status" = 'preparing';
    END IF;

    -- ④ 项目成员：manager + 商机 owner（同人只留 manager 一行）
    INSERT INTO "public"."project_members" ("project_id", "user_id", "project_role")
      SELECT p."id", p."manager_id", 'manager' FROM "public"."projects" p WHERE p."id" = v_project_id
      ON CONFLICT DO NOTHING;
    IF rec."owner_id" IS NOT NULL THEN
      INSERT INTO "public"."project_members" ("project_id", "user_id", "project_role")
        SELECT v_project_id, rec."owner_id", 'member'
        WHERE NOT EXISTS (SELECT 1 FROM "public"."projects" p WHERE p."id" = v_project_id AND p."manager_id" = rec."owner_id")
        ON CONFLICT DO NOTHING;
    END IF;

    -- ⑤ lost：closed_reason/closed_at 优先 crm.opportunities.markLost 审计快照回填
    IF rec."stage" = 'lost' AND rec."closed_at" IS NULL THEN
      v_audit_reason := NULL; v_audit_at := NULL;
      SELECT ae."after_json" ->> 'reason', ae."created_at" INTO v_audit_reason, v_audit_at
        FROM "public"."audit_events" ae
        WHERE ae."action" = 'crm.opportunities.markLost' AND ae."target_type" = 'crm_opportunity'
          AND ae."target_id" = rec."id" AND ae."result" = 'success'
        ORDER BY ae."created_at" DESC LIMIT 1;
      IF v_audit_at IS NOT NULL THEN
        UPDATE "public"."crm_opportunities"
          SET "closed_reason" = coalesce(nullif(v_audit_reason, ''), '历史输单（审计快照无原因，迁移回填）'),
              "closed_at" = v_audit_at, "updated_at" = now()
          WHERE "id" = rec."id";
        v_lost_backfilled := v_lost_backfilled + 1;
      ELSE
        UPDATE "public"."crm_opportunities"
          SET "closed_reason" = '历史输单，无审计快照（迭代18-01迁移统一回填）',
              "closed_at" = coalesce(rec."updated_at", now()), "updated_at" = now()
          WHERE "id" = rec."id";
        v_lost_fallback := v_lost_fallback + 1;
      END IF;
    END IF;
  END LOOP;

  -- 异常口径：处理后仍有商机未关联项目 → 计数并整体失败（异常不允许静默跳过）
  SELECT count(*)::integer INTO v_anomalies FROM "public"."crm_opportunities" WHERE "project_id" IS NULL;
  IF v_anomalies > 0 THEN
    RAISE EXCEPTION '18-01 补齐异常：% 条商机仍无关联项目', v_anomalies;
  END IF;

  processed := v_processed; reused := v_reused; created := v_created;
  lost_backfilled := v_lost_backfilled; lost_fallback := v_lost_fallback; anomalies := v_anomalies;
  RETURN NEXT;
END;
$func$;--> statement-breakpoint
DO $$
DECLARE
  r RECORD;
BEGIN
  SELECT * INTO r FROM "public"."crm_backfill_opportunity_projects"();
  RAISE NOTICE '18-01 存量商机项目补齐回执：处理 % 条（复用项目 % / 新建项目 %）；lost 关闭回填 % 条（审计快照 % / 统一文案 %）；异常 % 条',
    r.processed, r.reused, r.created, r.lost_backfilled + r.lost_fallback, r.lost_backfilled, r.lost_fallback, r.anomalies;
  -- 回执持久化到只追加审计表，供 18-04 部署核验；干净库空跑（0 处理）不留行
  IF r.processed > 0 THEN
    INSERT INTO "public"."audit_events" ("actor_id", "action", "target_type", "target_id", "result", "after_json")
    VALUES (
      NULL,
      'db.migration.iter18_01.opp_project_backfill',
      'crm_opportunity',
      NULL,
      'success',
      jsonb_build_object(
        'processed', r.processed, 'reused', r.reused, 'created', r.created,
        'lostBackfilled', r.lost_backfilled, 'lostFallback', r.lost_fallback, 'anomalies', r.anomalies
      )
    );
  END IF;
END $$;
