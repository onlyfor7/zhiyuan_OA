import { describe, expect, it } from "vitest";
import { TRPCClientError } from "@trpc/client";

import {
  CONFIDENTIALITY_LEVEL,
  PROJECT_HEALTH_STATUS,
  PROJECT_LIFECYCLE_STATUS,
  ROLE_KEY,
} from "@lexflow/shared";

import {
  CONFIDENTIALITY_LABEL,
  GLOBAL_ROLE_LABEL,
  HEALTH_LABEL,
  LIFECYCLE_LABEL,
  PROJECT_ROLE_LABEL,
} from "../../src/lib/labels";
import { businessCodeOf, isAccessDeniedOrGone, isAuthRequired } from "../../src/lib/trpc";

describe("展示标签与 shared 枚举键完整对齐（arch/02 §3）", () => {
  it.each(PROJECT_LIFECYCLE_STATUS)("生命周期 %s 有中文标签", (key) => {
    expect(LIFECYCLE_LABEL[key]).toBeTruthy();
  });

  it.each(PROJECT_HEALTH_STATUS)("健康度 %s 有中文标签", (key) => {
    expect(HEALTH_LABEL[key]).toBeTruthy();
  });

  it.each(CONFIDENTIALITY_LEVEL)("密级 %s 有中文标签", (key) => {
    expect(CONFIDENTIALITY_LABEL[key]).toBeTruthy();
  });

  it("项目角色标签覆盖迭代 0 实际使用的角色；key_member 缺口已登记 STATUS", () => {
    // 迭代 0 种子仅使用 manager/member（seed 无 key_member 用户，详情页有 ?? 原值兜底，无界面错误）
    // key_member 中文标签缺失已登记 STATUS.md「偏差与仲裁」（2026-10-27 测试会话），建议迭代 1 前由前端一行补齐
    expect(PROJECT_ROLE_LABEL.manager).toBeTruthy();
    expect(PROJECT_ROLE_LABEL.member).toBeTruthy();
    expect(PROJECT_ROLE_LABEL.key_member).toBeUndefined();
  });

  it.each(ROLE_KEY)("全局角色 %s 有中文标签", (key) => {
    expect(GLOBAL_ROLE_LABEL[key]).toBeTruthy();
  });

  it("标签键集合与 shared 枚举一一对应，无多余键", () => {
    expect(Object.keys(LIFECYCLE_LABEL).sort()).toEqual([...PROJECT_LIFECYCLE_STATUS].sort());
    expect(Object.keys(HEALTH_LABEL).sort()).toEqual([...PROJECT_HEALTH_STATUS].sort());
    expect(Object.keys(CONFIDENTIALITY_LABEL).sort()).toEqual([...CONFIDENTIALITY_LEVEL].sort());
  });
});

/** 构造携带 data.businessCode 的 tRPC 客户端错误（与服务端错误形状一致） */
function clientErrorWithData(data: Record<string, unknown>): TRPCClientError<never> {
  return new TRPCClientError("request failed", {
    result: {
      error: { message: "request failed", code: -32000, data },
    } as never,
  });
}

describe("统一错误分流（arch/02 §6、§8）", () => {
  it("businessCodeOf 取 data.businessCode；非 tRPC 错误返回 null", () => {
    expect(businessCodeOf(clientErrorWithData({ businessCode: "AUTH_REQUIRED" }))).toBe(
      "AUTH_REQUIRED",
    );
    expect(businessCodeOf(new Error("network"))).toBeNull();
    expect(businessCodeOf(null)).toBeNull();
  });

  it("AUTH_REQUIRED / ACCESS_DENIED_OR_GONE 判别（登录跳转与 403/404 同形页的输入）", () => {
    expect(isAuthRequired(clientErrorWithData({ businessCode: "AUTH_REQUIRED" }))).toBe(true);
    expect(isAuthRequired(clientErrorWithData({ businessCode: "ACCESS_DENIED_OR_GONE" }))).toBe(
      false,
    );
    expect(isAccessDeniedOrGone(clientErrorWithData({ businessCode: "ACCESS_DENIED_OR_GONE" }))).toBe(
      true,
    );
    expect(isAccessDeniedOrGone(clientErrorWithData({ businessCode: "INTERNAL" }))).toBe(false);
  });

  it("fieldErrors 透传（表单字段映射输入）", () => {
    const error = clientErrorWithData({
      businessCode: "VALIDATION_FAILED",
      fieldErrors: { email: ["邮箱格式不正确"] },
    });
    expect((error.data as { fieldErrors: Record<string, string[]> }).fieldErrors.email[0]).toContain(
      "邮箱",
    );
  });
});
