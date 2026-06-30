import { describe, expect, test, vi } from "vitest";

import taskedSubagentsExtension from "../extensions/index.js";

interface CapturedTool {
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: unknown;
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
    registerTool: vi.fn((config: CapturedTool) => { tool = config; }),
    registerCommand: vi.fn((_name: string, config: CapturedCommand) => { command = config; }),
  } as never);
  if (!tool) throw new Error("tool was not registered");
  if (!command) throw new Error("command was not registered");
  return { tool, command };
}

function renderCollapsedToolCall(args: unknown): string {
  const component = captureExtension().tool.renderCall(args, { fg: (_color, value) => value });
  return component.render()[0]?.trimEnd() ?? "";
}

function renderCollapsedToolResult(text: string): string {
  const component = captureExtension().tool.renderResult(
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

  test("tool schema and guidance expose TaskRun actions without plan or phase ids", () => {
    const tool = captureExtension().tool;
    const publicSurface = JSON.stringify({
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: tool.parameters,
    });

    expect(publicSurface).toContain("set_tasks");
    expect(publicSurface).toContain("edit_task");
    expect(publicSurface).toContain("edit_group");
    expect(publicSurface).toContain("patch_task_run");
    expect(publicSurface).toContain("expansionMode");
    expect(publicSurface).toContain("append_tasks");
    expect(publicSurface).toContain("attach");
    expect(publicSurface).toContain("wait");
    expect(publicSurface).toContain("taskRunId");
    expect(publicSurface).toContain("groupId");
    expect(publicSurface).not.toContain("replace_plan");
    expect(publicSurface).not.toContain("edit_plan");
    expect(publicSurface).not.toContain("planId");
    expect(publicSurface).not.toContain("phaseId");
    expect(publicSurface).not.toContain("phases");
  });

  test("collapsed tool calls show the action and target", () => {
    expect(renderCollapsedToolCall({})).toBe("tasked_subagents status");
    expect(renderCollapsedToolCall({ action: "list_agents" })).toBe("tasked_subagents list_agents");
    expect(renderCollapsedToolCall({ action: "result", assignmentId: "task-run-1-main-task-a1" }))
      .toContain("tasked_subagents result task-run-1-main-task-a1");
    expect(renderCollapsedToolCall({ action: "attach", targetId: "task-run-1" }))
      .toBe("tasked_subagents attach task-run-1");
    expect(renderCollapsedToolCall({ action: "set_tasks", title: "Task run", wait: true }))
      .toBe("tasked_subagents set_tasks Task run wait=true");
    expect(renderCollapsedToolCall({ action: "patch_task_run", taskRunId: "task-run-1", wait: true }))
      .toBe("tasked_subagents patch_task_run task-run-1 wait=true");
    expect(renderCollapsedToolCall({ action: "resolve", targetId: "task-run-1", prompt: "long fix summary that should not be shown" }))
      .toBe("tasked_subagents resolve task-run-1");
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
      "Use with set_tasks or edit_task: assign an agentHint to a concrete task.",
    ].join("\n"));

    expect(preview).toBe("Available subagent profiles · 3 agents");
  });

  test("collapsed JSON task reports render as compact summaries", () => {
    const report = {
      taskRunId: "task-run-1",
      groupId: "issue-fixedness-audit",
      taskId: "issue-296-typed-config-ports",
      assignmentId: "task-run-1-issue-fixedness-audit-issue-296-typed-config-ports-a1",
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
      expect(preview).not.toContain("planId");
      expect(preview.length).toBeLessThanOrEqual(120);
    }
  });
});
