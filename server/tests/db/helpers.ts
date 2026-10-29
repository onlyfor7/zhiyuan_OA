import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

import { loadEnvFile } from "../../src/db/env";
import * as schema from "../../src/db/schema";

loadEnvFile();

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL_TEST ?? "postgres://lexflow:lexflow_dev@localhost:15432/lexflow_test";

/** 迭代 0–4 全部业务表（arch/01 §1、arch/04 §2、arch/05 §2.1、arch/06 §2、arch/07 §2） */
export const ALL_TABLES = [
  "org_units",
  "users",
  "roles",
  "user_roles",
  "sessions",
  "clients",
  "matters",
  "projects",
  "project_members",
  "access_grants",
  "file_objects",
  "file_versions",
  "audit_events",
  "system_config",
  "code_sequences",
  "notifications",
  "stages",
  "milestones",
  "tasks",
  "deliverables",
  "plan_versions",
  "plan_items",
  "change_requests",
  "quality_issues",
  "quality_issue_events",
  "quality_check_items",
  "decisions",
  "weekly_reports",
  "archive_directories",
  "archive_links",
  "approval_instances",
  "approval_steps",
  "approval_policies",
  "project_templates",
  "meetings",
  "meeting_participants",
  "meeting_minutes",
  "meeting_action_items",
  "travel_requests",
  "travel_segments",
  "travel_events",
  "budgets",
  "budget_categories",
  "funding_requests",
  "expense_reports",
  "expense_items",
  "budget_ledger",
  "expense_adjustments",
  "timesheet_periods",
  "time_entries",
  "payment_receipts",
  "flow_definitions",
  "generic_requests",
] as const;

export async function migrateToLatest(url: string = TEST_DATABASE_URL): Promise<void> {
  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: resolve(process.cwd(), "drizzle") });
  await pool.end();
}

/** 干净库重放：清空 public 与 drizzle 簿记 schema 后重放全部迁移（工单 02 验收） */
export async function migrateFresh(url: string = TEST_DATABASE_URL): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  await client.query(
    "DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;",
  );
  await client.end();
  await migrateToLatest(url);
}

export async function tableNames(url: string = TEST_DATABASE_URL): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const result = await client.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  await client.end();
  return result.rows.map((row: { tablename: string }) => row.tablename);
}
