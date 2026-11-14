import { afterEach, describe, expect, it } from "vitest";

import { newClientKey, newIdempotencyKey } from "../../src/lib/form";

/**
 * 19-01 统一客户端 ID 生成入口（非安全上下文兼容）：
 * 优先 crypto.randomUUID → getRandomValues 构造 v4 → 计数器+时间戳兜底。
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 沿原型链取描述符（Node 的 crypto 方法可能在 Crypto.prototype 上） */
function descriptorOf(obj: object, key: string): PropertyDescriptor | undefined {
  let cur: object | null = obj;
  while (cur) {
    const d = Object.getOwnPropertyDescriptor(cur, key);
    if (d) return d;
    cur = Object.getPrototypeOf(cur);
  }
  return undefined;
}

const KEYS = ["randomUUID", "getRandomValues"] as const;
const snap = Object.fromEntries(KEYS.map((k) => [k, descriptorOf(globalThis.crypto, k)])) as Record<(typeof KEYS)[number], PropertyDescriptor | undefined>;

function patchCrypto(patch: Partial<Record<(typeof KEYS)[number], unknown>>) {
  for (const [k, v] of Object.entries(patch)) {
    Object.defineProperty(globalThis.crypto, k, { value: v, configurable: true, writable: true });
  }
}

afterEach(() => {
  for (const k of KEYS) {
    if (snap[k]) Object.defineProperty(globalThis.crypto, k, snap[k]!);
    else delete (globalThis.crypto as unknown as Record<string, unknown>)[k];
  }
});

describe("newClientKey（19-01 非安全上下文兼容）", () => {
  it("原生 randomUUID 可用时优先使用", () => {
    const sentinel = "11111111-2222-4333-8444-555555555555";
    patchCrypto({ randomUUID: () => sentinel });
    expect(newClientKey()).toBe(sentinel);
  });

  it("randomUUID 缺失但 getRandomValues 可用时生成合法 UUID v4（version/variant 位正确）", () => {
    patchCrypto({ randomUUID: undefined });
    const id = newClientKey();
    expect(id).toMatch(UUID_V4);
    expect(id[14]).toBe("4");
    expect("89ab").toContain(id[19]);
  });

  it("连续生成 1000 个无重复（getRandomValues 路径）", () => {
    patchCrypto({ randomUUID: undefined });
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = newClientKey();
      expect(id).toMatch(UUID_V4);
      seen.add(id);
    }
    expect(seen.size).toBe(1000);
  });

  it("randomUUID 与 getRandomValues 都不可用时最后兜底：不抛错且格式合法（不单独依赖 Math.random）", () => {
    patchCrypto({
      randomUUID: undefined,
      getRandomValues: undefined,
    });
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) {
      expect(() => newClientKey()).not.toThrow();
      const id = newClientKey();
      expect(id).toMatch(UUID_V4);
      ids.add(id);
    }
    expect(ids.size).toBe(200);
  });

  it("newIdempotencyKey 委托统一入口，格式合法", () => {
    expect(newIdempotencyKey()).toMatch(UUID_V4);
  });
});
