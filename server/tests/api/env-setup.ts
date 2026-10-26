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
