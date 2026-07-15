import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import taskedSubagentsExtension from "../extensions/index.js";
import { TaskedSubagentsController } from "../src/orchestration/controller.js";
import { PersistenceCoordinator } from "../src/state/persistence-coordinator.js";
import { DurableObjectStore } from "../src/state/object-store.js";
import { sessionStoragePaths } from "../src/state/storage-paths.js";

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
  test("session tree fences restore before async selection and shutdown awaits a flush", async () => {
    let sessionTree: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    let sessionShutdown: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const fenceRestore = vi.spyOn(TaskedSubagentsController.prototype, "fenceRestore");
    const flushPersistence = vi.spyOn(TaskedSubagentsController.prototype, "flushPersistence");
    const context = {
      cwd: "/tmp/project", mode: "tui",
      sessionManager: { getBranch: () => [], getEntries: () => [], getSessionId: () => "generic-session" },
      ui: {
        theme: { fg: (_color: string, value: string) => value }, notify: vi.fn(), onTerminalInput: vi.fn(),
        setStatus: vi.fn(), setWidget: vi.fn(), requestRender: vi.fn(),
      },
    };
    taskedSubagentsExtension({
      on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
        if (event === "session_tree") sessionTree = handler;
        if (event === "session_shutdown") sessionShutdown = handler;
      }),
      registerMessageRenderer: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(), appendEntry: vi.fn(), sendMessage: vi.fn(),
    } as never);

    await sessionTree?.({}, context);
    expect(fenceRestore).toHaveBeenCalledTimes(1);
    await sessionShutdown?.({}, context);
    expect(flushPersistence).toHaveBeenCalledWith(context);
  });

  test("session startup pins all valid branch checkpoint graphs before installing restored state", async () => {
    const xdgDataHome = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-extension-"));
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdgDataHome;
    const dataRoot = join(xdgDataHome, "pi-tasked-subagents");
    const sessionId = "generic-session";
    const store = new DurableObjectStore(dataRoot);
    const appender = { append: vi.fn() };
    const coordinator = new PersistenceCoordinator(store, appender);
    try {
      const active = await coordinator.checkpoint({ version: 4, taskRuns: [], updatedAt: 1 }, { sessionId, visiblePointers: [], now: 1 });
      if (!active.committed) throw new Error("active checkpoint was not committed");
      const inactive = await coordinator.checkpoint({ version: 4, taskRuns: [], updatedAt: 2 }, { sessionId, visiblePointers: [active.pointer], now: 2 });
      if (!inactive.committed) throw new Error("inactive checkpoint was not committed");
      const paths = sessionStoragePaths(dataRoot, sessionId);
      await writeFile(paths.refsPath, JSON.stringify({ version: 1, checkpointIds: [active.pointer.checkpointId] }));

      let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
      let refsAtInstall: { checkpointIds: string[] } | undefined;
      const originalRestoreState = TaskedSubagentsController.prototype.restoreState;
      const restoreState = vi.spyOn(TaskedSubagentsController.prototype, "restoreState").mockImplementation(function (this: TaskedSubagentsController, state, archiveRefs) {
        refsAtInstall = JSON.parse(readFileSync(paths.refsPath, "utf8")) as { checkpointIds: string[] };
        return originalRestoreState.call(this, state, archiveRefs);
      });
      const pi = {
        on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
          if (event === "session_start") sessionStart = handler;
        }),
        registerMessageRenderer: vi.fn(), registerTool: vi.fn(), registerCommand: vi.fn(), appendEntry: vi.fn(), sendMessage: vi.fn(),
      };
      taskedSubagentsExtension(pi as never);
      const context = {
        cwd: "/tmp/project", mode: "json",
        sessionManager: {
          getBranch: () => [{ type: "custom", customType: "pi-tasked-subagents:state", data: active.pointer }],
          getEntries: () => [
            { type: "custom", customType: "pi-tasked-subagents:state", data: active.pointer },
            { type: "custom", customType: "pi-tasked-subagents:state", data: inactive.pointer },
          ],
          getSessionId: () => sessionId,
        },
        ui: { theme: { fg: (_color: string, value: string) => value }, notify: vi.fn(), onTerminalInput: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn(), requestRender: vi.fn() },
      };

      await sessionStart?.({}, context);

      expect(restoreState).toHaveBeenCalledOnce();
      expect(refsAtInstall?.checkpointIds).toEqual([active.pointer.checkpointId, inactive.pointer.checkpointId].sort());
      expect(JSON.parse(await readFile(paths.refsPath, "utf8"))).toEqual(refsAtInstall);
      expect(pi.appendEntry).not.toHaveBeenCalled();
    } finally {
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdgDataHome;
      await rm(xdgDataHome, { recursive: true, force: true });
    }
  });

  test("Escape cancels active subagent runs without consuming Pi's interrupt", async () => {
    let sessionStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    const terminalInputs: Array<(data: string) => { consume?: boolean } | undefined> = [];
    let resolveFirstCancellation: ((count: number) => void) | undefined;
    const firstCancellation = new Promise<number>((resolve) => {
      resolveFirstCancellation = resolve;
    });
    const cancelActiveRuns = vi.spyOn(TaskedSubagentsController.prototype, "cancelActiveRuns")
      .mockReturnValueOnce(firstCancellation)
      .mockResolvedValue(1);
    const notify = vi.fn();

    taskedSubagentsExtension({
      on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
        if (event === "session_start") sessionStart = handler;
      }),
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as never);

    expect(sessionStart).toBeDefined();
    await sessionStart?.({}, {
      cwd: "/tmp/project",
      mode: "tui",
      sessionManager: { getBranch: () => [], getSessionId: () => "session-1" },
      ui: {
        theme: { fg: (_color: string, value: string) => value },
        notify,
        onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
          terminalInputs.push(handler);
          return vi.fn();
        },
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        requestRender: vi.fn(),
      },
    });

    expect(terminalInputs[0]?.("\u001b")).toBeUndefined();
    await sessionStart?.({}, {
      cwd: "/tmp/project",
      mode: "tui",
      sessionManager: { getBranch: () => [], getSessionId: () => "session-2" },
      ui: {
        theme: { fg: (_color: string, value: string) => value },
        notify,
        onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => {
          terminalInputs.push(handler);
          return vi.fn();
        },
        setStatus: vi.fn(),
        setWidget: vi.fn(),
        requestRender: vi.fn(),
      },
    });
    expect(terminalInputs[1]?.("\u001b")).toBeUndefined();
    await vi.waitFor(() => expect(cancelActiveRuns).toHaveBeenCalledTimes(2));
    resolveFirstCancellation?.(1);
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith("Cancelled 1 active subagent run.", "info"));
  });

  test("slash command description includes resolve", () => {
    expect(captureExtension().command.description).toContain("resolve");
  });

  test("tool schema and guidance expose TaskRun actions and upfront flat workflow planning without plan or phase ids", () => {
    const tool = captureExtension().tool;
    const guidance = [tool.promptSnippet, ...tool.promptGuidelines].join("\n");
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
    expect(guidance).toContain("complete plan");
    expect(guidance).toContain("upfront");
    expect(guidance).toContain("groups plus flat tasks");
    expect(guidance).toContain("group references");
    expect(guidance).toContain("not hidden steps");
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
