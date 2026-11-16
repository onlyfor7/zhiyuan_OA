import { asc, eq } from "drizzle-orm";
import pg from "pg";
import { pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";

import { loadEnvFile, requireDatabaseUrl } from "../env";
import * as schema from "../schema";
import { flowDefinitions } from "../schema";
import { FlowMigrateAnomaly, migrateFlowV1toV2, type FlowV1Definition } from "./flow-v2";

export interface FlowV2MigrationReceipt {
  processed: number;
  converted: number;
  anomalies: number;
  backupRows: number;
  lines: string[];
}

/**
 * v1→v2 迁移脚本（arch/14 §12.1/工单 §6.2；幂等：二次运行 processed=0 零变更）。
 * 先建备份表 flow_definitions_bak_20（已存在则跳过），逐行转换 definition_version=1 的流程。
 */
export async function runFlowV2Migration(databaseUrl: string): Promise<FlowV2MigrationReceipt> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });

  const receipt: FlowV2MigrationReceipt = { processed: 0, converted: 0, anomalies: 0, backupRows: 0, lines: [] };
  try {
    await db.transaction(async (tx) => {
      await tx.execute(
        `CREATE TABLE IF NOT EXISTS "public"."flow_definitions_bak_20" AS TABLE "public"."flow_definitions"`,
      );
      const backup = await tx.execute(`SELECT count(*)::int AS n FROM "public"."flow_definitions_bak_20"`);
      receipt.backupRows = (backup.rows[0] as { n: number }).n;

      const rows = await tx
        .select({
          id: flowDefinitions.id,
          name: flowDefinitions.name,
          versionNo: flowDefinitions.versionNo,
          definitionJson: flowDefinitions.definitionJson,
        })
        .from(flowDefinitions)
        .where(eq(flowDefinitions.definitionVersion, 1))
        .orderBy(asc(flowDefinitions.name));

      for (const row of rows) {
        receipt.processed += 1;
        try {
          const v2 = migrateFlowV1toV2(row.definitionJson as unknown as FlowV1Definition);
          await tx
            .update(flowDefinitions)
            .set({ definitionJson: v2 as unknown as Record<string, unknown>, definitionVersion: 2 })
            .where(eq(flowDefinitions.id, row.id));
          receipt.converted += 1;
          receipt.lines.push(`✓ ${row.name} v${row.versionNo} → v2`);
        } catch (error) {
          receipt.anomalies += 1;
          const detail = error instanceof FlowMigrateAnomaly ? error.anomalies.join("；") : String(error);
          receipt.lines.push(`✗ ${row.name} v${row.versionNo} 异常：${detail}`);
        }
      }
    });
  } finally {
    await pool.end();
  }
  return receipt;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  loadEnvFile();
  runFlowV2Migration(requireDatabaseUrl())
    .then((receipt) => {
      console.log("[flow-v2] 迁移回执：");
      for (const line of receipt.lines) console.log(`  ${line}`);
      console.log(
        `[flow-v2] processed=${receipt.processed} converted=${receipt.converted} anomalies=${receipt.anomalies} backupRows=${receipt.backupRows}`,
      );
    })
    .catch((error) => {
      console.error("[flow-v2] 迁移失败：", error);
      process.exitCode = 1;
    });
}
