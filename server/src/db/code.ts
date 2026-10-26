import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { db } from "./client";
import { CODE_SERIAL_PADDING } from "@lexflow/shared";

/** 最小执行接口：全局 db 或事务 tx 均可传入（arch/00 §3.11 同事务要求） */
interface SqlRunner {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
}

/**
 * 业务编号生成（arch/00 §3.5）：前缀-年份-五位序号。
 * 单语句 INSERT ... ON CONFLICT DO UPDATE ... RETURNING，事务内自增、并发安全。
 */
export async function nextCode(prefix: string, runner: SqlRunner = db): Promise<string> {
  const year = new Date().getFullYear();
  const result = await runner.execute(sql`
    INSERT INTO code_sequences (prefix, year, next_value)
    VALUES (${prefix}, ${year}, 1)
    ON CONFLICT (prefix, year) DO UPDATE SET next_value = code_sequences.next_value + 1
    RETURNING next_value
  `);
  const row = result.rows[0] as { next_value: number };
  const serial = String(row.next_value).padStart(CODE_SERIAL_PADDING, "0");
  return `${prefix}-${year}-${serial}`;
}
