import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 必须在任何 src 模块之前设置（ESM 导入提升，故独立成首个被导入的副作用模块）。
 * 全部指向 lexflow_test 与临时存储目录，绝不触碰 dev 库与真实 storage。
 */
process.env.DATABASE_URL = "postgres://lexflow:lexflow_dev@localhost:15432/lexflow_test";
process.env.SESSION_SECRET = "0123456789abcdef0123456789abcdef";
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), "lexflow-storage-"));
process.env.PORT = "3999";
// 9a-04：测试环境 statement_timeout 调低（2s），pg_sleep 探针快速验证截断（prod 默认 15s 经 env 注入）
process.env.PG_STATEMENT_TIMEOUT_MS = "2000";
// 慢查询阈值调低，warn 探针快速触发（默认 500ms）
process.env.SLOW_QUERY_MS = "100";
