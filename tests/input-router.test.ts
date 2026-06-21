import { describe, expect, test, vi } from "vitest";

import { extractTaskedSubagentsRequest, routeInput } from "../src/orchestration/input-router.js";

describe("input router", () => {
  test("extracts explicit tasked-subagents requests", () => {
    expect(extractTaskedSubagentsRequest("@tasked-subagents inspect repo")).toBe("inspect repo");
    expect(extractTaskedSubagentsRequest("tasked-subagents: inspect repo")).toBe("inspect repo");
    expect(extractTaskedSubagentsRequest("tasked subagents: inspect repo")).toBe("inspect repo");
  });

  test("passes through ordinary chat and slash commands", () => {
    const controller = { handleUserAsk: vi.fn() };
    expect(routeInput("hello", "interactive", controller as never).action).toBe("continue");
    expect(routeInput("/tasked-subagents status", "interactive", controller as never).action).toBe("continue");
    expect(controller.handleUserAsk).not.toHaveBeenCalled();
  });

  test("handles explicit requests by creating a plan", () => {
    const controller = { handleUserAsk: vi.fn() };
    expect(routeInput("@tasked-subagents inspect repo", "interactive", controller as never).action).toBe("handled");
    expect(controller.handleUserAsk).toHaveBeenCalledWith("inspect repo");
  });

  test.each([
    ["", undefined],
    ["   ", "interactive"],
  ] as const)("continues empty input %#", (text, source) => {
    const controller = { handleUserAsk: vi.fn() };
    expect(routeInput(text, source, controller as never).action).toBe("continue");
    expect(controller.handleUserAsk).not.toHaveBeenCalled();
  });

  test("continues extension-sourced explicit triggers", () => {
    const controller = { handleUserAsk: vi.fn() };
    expect(routeInput("@tasked-subagents inspect repo", "extension", controller as never).action).toBe("continue");
    expect(controller.handleUserAsk).not.toHaveBeenCalled();
  });

  test("handles explicit trigger with undefined source and forwards ctx", () => {
    const controller = { handleUserAsk: vi.fn() };
    const ctx = { sessionId: "session-1" };

    expect(routeInput("tasked subagents: inspect repo", undefined, controller as never, ctx as never).action).toBe("handled");

    expect(controller.handleUserAsk).toHaveBeenCalledWith("inspect repo", ctx);
  });
});
