import { describe, expect, test, vi } from "vitest";

import taskedSubagentsExtension from "../extensions/index.js";

interface CapturedTool {
  renderCall: (args: unknown, theme: { fg(color: string, text: string): string }) => { render(width?: number): string[] };
  renderResult: (result: { content?: Array<{ type: string; text: string }> }, options: { expanded: boolean; isPartial: boolean }, theme: { fg(color: string, text: string): string }) => { render(width?: number): string[] };
}

interface CapturedCommand {
  description: string;
}

function captureExtension(): { tool: CapturedTool; command: CapturedCommand } {
  let tool: CapturedTool | undefined;
  let command: CapturedCommand | undefined;
  taskedSubagentsExtension({
    on: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((definition: CapturedTool) => {
      tool = definition;
    }),
    registerCommand: vi.fn((_name: string, definition: CapturedCommand) => {
      command = definition;
    }),
  } as never);
  if (!tool) throw new Error("tool was not registered");
  if (!command) throw new Error("command was not registered");
  return { tool, command };
}

function captureTool(): CapturedTool {
  return captureExtension().tool;
}

function renderCollapsedToolCall(args: unknown): string {
  const component = captureTool().renderCall(args, { fg: (_color, value) => value });
  return component.render()[0]?.trimEnd() ?? "";
}

function renderCollapsedToolResult(text: string): string {
  const component = captureTool().renderResult(
    { content: [{ type: "text", text }] },
    { expanded: false, isPartial: false },
    { fg: (_color, value) => value },
  );
  return component.render()[0] ?? "";
}

describe("tasked_subagents extension rendering", () => {
  test("slash command description includes resolve", () => {
    expect(captureExtension().command.description).toContain("resolve");
  });

  test("collapsed tool calls show the action and target", () => {
    expect(renderCollapsedToolCall({})).toBe("tasked_subagents status");
    expect(renderCollapsedToolCall({ action: "list_agents" })).toBe("tasked_subagents list_agents");
    expect(renderCollapsedToolCall({ action: "result", assignmentId: "plan-1-issue-fixedness-audit-issue-296-typed-config-ports-a1" }))
      .toContain("tasked_subagents result plan-1-issue-fixedness-audit-issue-296-typed-config-ports-a1");
    expect(renderCollapsedToolCall({ action: "resolve", targetId: "issue-311-omnibox-localhost-skeleton", prompt: "long fix summary that should not be shown" }))
      .toBe("tasked_subagents resolve issue-311-omnibox-localhost-skeleton");
  });

  test("collapsed empty results render an explicit no-output preview", () => {
    expect(renderCollapsedToolResult("")).toBe("tasked_subagents no output");
    expect(renderCollapsedToolResult("  \n\t  ")).toBe("tasked_subagents no output");
  });

  test("collapsed agent-list results render the profile count", () => {
    const preview = renderCollapsedToolResult([
      "Available subagent profiles:",
      "  - coordinator",
      "  - delegate",
      "  - reviewer model=gpt-5 tools=read,bash",
      "",
      "Names only by default. Use details=true or --details for non-sensitive metadata.",
      "",
      "Use with replace_plan: assign an agentHint to a concrete task inside a phase.",
    ].join("\n"));

    expect(preview).toBe("Available subagent profiles · 3 agents");
  });

  test("collapsed JSON task reports render as compact summaries", () => {
    const report = {
      planId: "plan-1",
      phaseId: "issue-fixedness-audit",
      taskId: "issue-296-typed-config-ports",
      assignmentId: "plan-1-issue-fixedness-audit-issue-296-typed-config-ports-a1",
      status: "completed",
      summary: "Verdict: fixed. origin/main includes the complete runtime config seam and typed ports evidence.",
      criteriaEvidence: [{ criteriaIndex: 0, evidence: "Evidence that should stay hidden in collapsed mode." }],
      artifacts: [],
      followUps: [],
    };

    const minified = renderCollapsedToolResult(JSON.stringify(report));
    const pretty = renderCollapsedToolResult(JSON.stringify(report, null, 2));

    for (const preview of [minified, pretty]) {
      expect(preview).toContain("DONE");
      expect(preview).toContain("issue-296-typed-config-ports");
      expect(preview).toContain("Verdict: fixed");
      expect(preview).not.toBe("{");
      expect(preview).not.toContain("criteriaEvidence");
      expect(preview.length).toBeLessThanOrEqual(120);
    }
  });
});
