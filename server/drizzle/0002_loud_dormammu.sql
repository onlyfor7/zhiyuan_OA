-- 迭代 1 · 工单 02b（架构特批由后端会话执行）：
-- plan_items 增补 name 列（arch/04 §2.3 v1.1：版本时点快照名，改名不改历史版本显示）。
-- 加列 → 按 item_type JOIN 来源表回填现名 → SET NOT NULL（存量行在迁移内完成回填）。

ALTER TABLE "plan_items" ADD COLUMN "name" text;--> statement-breakpoint

UPDATE "plan_items" SET "name" = "s"."name"
FROM "stages" AS "s"
WHERE "plan_items"."ref_id" = "s"."id" AND "plan_items"."item_type" = 'stage';--> statement-breakpoint

UPDATE "plan_items" SET "name" = "m"."name"
FROM "milestones" AS "m"
WHERE "plan_items"."ref_id" = "m"."id" AND "plan_items"."item_type" = 'milestone';--> statement-breakpoint

UPDATE "plan_items" SET "name" = "t"."title"
FROM "tasks" AS "t"
WHERE "plan_items"."ref_id" = "t"."id" AND "plan_items"."item_type" = 'task';--> statement-breakpoint

-- 兜底：极端情况下来源行缺失时以编号占位，保证 NOT NULL 约束可建立（正常数据不会命中）
UPDATE "plan_items" SET "name" = '(未命名)' WHERE "name" IS NULL;--> statement-breakpoint

ALTER TABLE "plan_items" ALTER COLUMN "name" SET NOT NULL;
