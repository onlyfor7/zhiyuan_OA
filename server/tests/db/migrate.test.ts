import { describe, expect, it } from "vitest";

import { ALL_TABLES, migrateFresh, migrateToLatest, tableNames, TEST_DATABASE_URL } from "./helpers";

describe("迁移重放（干净 lexflow_test 库）", () => {
  it("DROP SCHEMA 后重放迁移成功，16 张业务表齐备", async () => {
    await migrateFresh();
    const names = await tableNames(TEST_DATABASE_URL);
    for (const table of ALL_TABLES) {
      expect(names).toContain(table);
    }
    const businessTables = names.filter((name) => name !== "__drizzle_migrations");
    expect(businessTables).toHaveLength(ALL_TABLES.length);
  });

  it("对已最新库重复执行迁移为无操作（幂等）", async () => {
    await migrateToLatest();
    const names = await tableNames(TEST_DATABASE_URL);
    for (const table of ALL_TABLES) {
      expect(names).toContain(table);
    }
  });
});
