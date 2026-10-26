import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { nextCode } from "../../src/db/code";
import * as schema from "../../src/db/schema";
import { migrateToLatest, TEST_DATABASE_URL } from "./helpers";

describe("next_code 事务内自增", () => {
  it("20 次并发取号无重号、序号连续", async () => {
    await migrateToLatest();
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 20 });
    const db = drizzle(pool, { schema });
    try {
      const year = new Date().getFullYear();
      const codes = await Promise.all(
        Array.from({ length: 20 }, () => nextCode("TST", db)),
      );
      expect(new Set(codes).size).toBe(20);
      const serials = codes.map((code) => Number(code.split("-")[2]));
      expect(new Set(serials).size).toBe(20);
      for (const serial of serials) {
        expect(serial).toBeGreaterThanOrEqual(1);
        expect(serial).toBeLessThanOrEqual(20);
        expect(codes).toContain(`TST-${year}-${String(serial).padStart(5, "0")}`);
      }
    } finally {
      await pool.end();
    }
  });
});
