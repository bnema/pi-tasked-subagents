import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ensureTaskGraphRequest } from "../src/launcher/interface.js";
import { PiRunnerAdapter } from "../src/launcher/pi-runner-adapter.js";
import type { SubagentRunHandle } from "../src/types.js";

async function withLaunchedAdapter(runId: string, result: unknown, testBody: (adapter: PiRunnerAdapter, handle: SubagentRunHandle) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
  try {
    const asyncRoot = path.join(root, "async");
    const resultsRoot = path.join(root, "results");
    const adapter = new PiRunnerAdapter({ piBin: "true", asyncDirRootOverride: asyncRoot, resultsDirOverride: resultsRoot });
    const handle = await adapter.launchTaskGraph({
      runId,
      title: "Run",
      taskSummary: "Run",
      tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
    }, { cwd: process.cwd(), sessionId: "test", pi: {} as never });
    await writeFile(path.join(resultsRoot, `${runId}.json`), JSON.stringify(result), "utf8");
    await testBody(adapter, handle);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("PiRunnerAdapter task graph boundary", () => {
  test("reports clear validation errors for malformed task graph requests", () => {
    expect(() => ensureTaskGraphRequest({
      runId: "run-1",
      title: "Run",
      taskSummary: "Run",
      tasks: [{ taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
    } as never)).toThrow("Task assignment id is required");
  });

  test("requires task-run and task identifiers on task graph entries", () => {
    expect(() => ensureTaskGraphRequest({
      runId: "run-1",
      title: "Run",
      taskSummary: "Run",
      tasks: [{ assignmentId: "a1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
    } as never)).toThrow("Task assignment a1 missing taskRunId");

    expect(() => ensureTaskGraphRequest({
      runId: "run-1",
      title: "Run",
      taskSummary: "Run",
      tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: " ", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
    })).toThrow("Task assignment a1 has invalid groupId");
  });

  test("rejects self-dependent and cyclic task graph dependencies", () => {
    const base = {
      runId: "run-1",
      title: "Run",
      taskSummary: "Run",
    };

    expect(() => ensureTaskGraphRequest({
      ...base,
      tasks: [
        { assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do", dependsOn: ["a1"] },
      ],
    })).toThrow("Task assignment a1 cannot depend on itself");

    expect(() => ensureTaskGraphRequest({
      ...base,
      tasks: [
        { assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do", dependsOn: ["a2"] },
        { assignmentId: "a2", taskRunId: "task-run-1", groupId: "main", taskId: "t2", agent: "delegate", prompt: "do", taskSummary: "do", dependsOn: ["a1"] },
      ],
    })).toThrow("Task assignment dependency cycle detected");
  });

  test("requires a cwd from the request or runtime context", async () => {
    const adapter = new PiRunnerAdapter({ piBin: "true" });

    await expect(adapter.launchTaskGraph({
      runId: "run-no-cwd",
      title: "Run",
      taskSummary: "Run",
      tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
    }, undefined as never)).rejects.toThrow("Task graph cwd is required");
  });

  test("falls back to runtime cwd when request cwd is blank", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const asyncRoot = path.join(root, "async");
      const resultsRoot = path.join(root, "results");
      const runtimeCwd = path.join(root, "runtime-cwd");
      const adapter = new PiRunnerAdapter({ piBin: "true", asyncDirRootOverride: asyncRoot, resultsDirOverride: resultsRoot });

      await adapter.launchTaskGraph({
        runId: "run-blank-cwd",
        title: "Run",
        taskSummary: "Run",
        cwd: "   ",
        tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
      }, { cwd: runtimeCwd, sessionId: "test", pi: {} as never });

      const config = JSON.parse(await readFile(path.join(asyncRoot, "run-blank-cwd", "config.json"), "utf8"));
      expect(config.children[0].cwd).toBe(runtimeCwd);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("normalizes assignment and dependency ids before writing runner config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const asyncRoot = path.join(root, "async");
      const resultsRoot = path.join(root, "results");
      const adapter = new PiRunnerAdapter({ piBin: "true", asyncDirRootOverride: asyncRoot, resultsDirOverride: resultsRoot });

      const handle = await adapter.launchTaskGraph({
        runId: "run-normalized-deps",
        title: "Run",
        taskSummary: "Run",
        tasks: [
          { assignmentId: " a1 ", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" },
          { assignmentId: "a2", taskRunId: "task-run-1", groupId: "main", taskId: "t2", agent: "delegate", prompt: "do", taskSummary: "do", cwd: "   ", dependsOn: [" a1 "] },
        ],
      }, { cwd: process.cwd(), sessionId: "test", pi: {} as never });

      const config = JSON.parse(await readFile(path.join(asyncRoot, "run-normalized-deps", "config.json"), "utf8"));
      expect(handle.assignments.map((assignment) => assignment.assignmentId)).toEqual(["a1", "a2"]);
      expect(config.children.map((child: { id: string }) => child.id)).toEqual(["a1", "a2"]);
      expect(config.children[1].dependsOn).toEqual(["a1"]);
      expect(config.children[1].cwd).toBe(process.cwd());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects unsafe run ids", async () => {
    const adapter = new PiRunnerAdapter({ piBin: "true" });
    await expect(adapter.launchTaskGraph({
      runId: "../escape",
      title: "Bad",
      taskSummary: "Bad",
      tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
    }, { cwd: process.cwd(), sessionId: "test", pi: {} as never })).rejects.toThrow("Unsafe run ID");
  });

  test("returns attention when wait times out with only running status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const asyncRoot = path.join(root, "async");
      const resultsRoot = path.join(root, "results");
      const runDir = path.join(asyncRoot, "run-1");
      await mkdir(runDir, { recursive: true });
      await mkdir(resultsRoot, { recursive: true });
      await writeFile(path.join(runDir, "status.json"), JSON.stringify({
        runId: "run-1",
        state: "running",
        steps: [{ id: "a1", status: "running", agent: "delegate" }],
      }), "utf8");

      const adapter = new PiRunnerAdapter({ piBin: "true", asyncDirRootOverride: asyncRoot, resultsDirOverride: resultsRoot });
      const handle: SubagentRunHandle = {
        runId: "run-1",
        asyncId: "run-1",
        asyncDir: runDir,
        resultPath: path.join(resultsRoot, "run-1.json"),
        assignments: [],
      };
      const status = await adapter.waitForRunSignal(handle, { timeoutMs: 25 });

      expect(status).toBe("attention");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("waits for final status snapshot after terminal result appears", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const asyncRoot = path.join(root, "async");
      const resultsRoot = path.join(root, "results");
      const runDir = path.join(asyncRoot, "run-1");
      await mkdir(runDir, { recursive: true });
      await mkdir(resultsRoot, { recursive: true });
      const statusPath = path.join(runDir, "status.json");
      await writeFile(statusPath, JSON.stringify({
        runId: "run-1",
        state: "running",
        steps: [
          { id: "a1", status: "completed", agent: "delegate" },
          { id: "a2", status: "running", agent: "delegate" },
        ],
      }), "utf8");
      await writeFile(path.join(resultsRoot, "run-1.json"), JSON.stringify({ runId: "run-1", state: "failed", success: false, results: [] }), "utf8");

      const snapshots: string[] = [];
      const adapter = new PiRunnerAdapter({ piBin: "true", asyncDirRootOverride: asyncRoot, resultsDirOverride: resultsRoot });
      const handle: SubagentRunHandle = {
        runId: "run-1",
        asyncId: "run-1",
        asyncDir: runDir,
        resultPath: path.join(resultsRoot, "run-1.json"),
        assignments: [],
      };
      const status = await adapter.waitForRunSignal(handle, {
        timeoutMs: 1_000,
        onUpdate: async (snapshot) => {
          snapshots.push(snapshot.steps.map((step) => `${step.id}:${step.status}`).join(","));
          if (snapshot.status === "running") {
            await writeFile(statusPath, JSON.stringify({
              runId: "run-1",
              state: "failed",
              steps: [
                { id: "a1", status: "completed", agent: "delegate" },
                { id: "a2", status: "skipped", agent: "delegate" },
              ],
            }), "utf8");
          }
        },
      });

      expect(status).toBe("failed");
      expect(snapshots).toContain("a1:completed,a2:skipped");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("raw output wins when reading run results", async () => {
    await withLaunchedAdapter("run-raw", { rawOutput: "raw report", summary: "summary" }, async (adapter, handle) => {
      await expect(adapter.getRunResult(handle)).resolves.toBe("raw report");
    });
  });

  test("handle result path overrides tracked launch result path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const asyncRoot = path.join(root, "async");
      const resultsRoot = path.join(root, "results");
      const overrideResultPath = path.join(root, "override-results", "run-override.json");
      const adapter = new PiRunnerAdapter({ piBin: "true", asyncDirRootOverride: asyncRoot, resultsDirOverride: resultsRoot });
      const handle = await adapter.launchTaskGraph({
        runId: "run-override",
        title: "Run",
        taskSummary: "Run",
        tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
      }, { cwd: process.cwd(), sessionId: "test", pi: {} as never });
      await mkdir(path.dirname(overrideResultPath), { recursive: true });
      await writeFile(path.join(resultsRoot, "run-override.json"), JSON.stringify({ rawOutput: "tracked path" }), "utf8");
      await writeFile(overrideResultPath, JSON.stringify({ rawOutput: "override path" }), "utf8");

      await expect(adapter.getRunResult({ ...handle, resultPath: overrideResultPath })).resolves.toBe("override path");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("multi-result files return step summaries and output metadata", async () => {
    await withLaunchedAdapter("run-multi", {
      results: [
        { stepId: "a1", rawOutput: "raw one", output: "output one", summary: "one", success: true },
        { stepId: "a2", output: "output two", summary: "two", error: "boom", success: false },
      ],
    }, async (adapter, handle) => {
      const raw = await adapter.getRunResult(handle);
      expect(JSON.parse(raw ?? "{}")).toEqual({
        runId: "run-multi",
        results: [
          { stepId: "a1", output: "raw one", summary: "one", success: true },
          { stepId: "a2", output: "output two", summary: "two", error: "boom", success: false },
        ],
      });
    });
  });

  test.each([
    ["rawOutput", { results: [{ stepId: "a1", rawOutput: "child raw", output: "child output" }], summary: "root summary" }, "child raw"],
    ["output", { results: [{ stepId: "a1", output: "child output" }], summary: "root summary" }, "child output"],
    ["root summary", { results: [{ stepId: "a1" }], summary: "root summary" }, "root summary"],
  ] as const)("single result falls back to %s", async (_name, result, expected) => {
    const runId = `run-single-${_name.replace(/\s/gu, "-")}`;
    await withLaunchedAdapter(runId, result, async (adapter, handle) => {
      await expect(adapter.getRunResult(handle)).resolves.toBe(expected);
    });
  });

  test("writes task_graph runner config", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const asyncRoot = path.join(root, "async");
      const resultsRoot = path.join(root, "results");
      const adapter = new PiRunnerAdapter({ piBin: "true", asyncDirRootOverride: asyncRoot, resultsDirOverride: resultsRoot });
      const ref = await adapter.launchTaskGraph({
        runId: "run-1",
        title: "Run",
        taskSummary: "Run",
        tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
      }, { cwd: process.cwd(), sessionId: "test", pi: {} as never });

      expect(ref).toEqual({
        runId: "run-1",
        asyncId: "run-1",
        asyncDir: path.join(asyncRoot, "run-1"),
        resultPath: path.join(resultsRoot, "run-1.json"),
        sessionFile: undefined,
        artifactPath: undefined,
        assignments: [{ assignmentId: "a1", runId: "run-1", resultPath: path.join(resultsRoot, "run-1.json") }],
      });
      const config = JSON.parse(await readFile(path.join(asyncRoot, "run-1", "config.json"), "utf8"));
      expect(config.mode).toBe("task_graph");
      expect(config.children[0].id).toBe("a1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses restored handle paths outside configured roots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const asyncDir = path.join(root, "restored-async");
      const resultPath = path.join(root, "restored-results", "run-restored.json");
      await mkdir(asyncDir, { recursive: true });
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(path.join(asyncDir, "status.json"), JSON.stringify({
        runId: "run-restored",
        state: "complete",
        steps: [{ id: "a1", status: "completed", agent: "delegate" }],
      }), "utf8");
      await writeFile(resultPath, JSON.stringify({ runId: "run-restored", state: "complete", rawOutput: "restored output" }), "utf8");

      const adapter = new PiRunnerAdapter({
        piBin: "true",
        asyncDirRootOverride: path.join(root, "unused-async-root"),
        resultsDirOverride: path.join(root, "unused-results-root"),
      });
      const handle: SubagentRunHandle = {
        runId: "run-restored",
        asyncId: "run-restored",
        asyncDir,
        resultPath,
        assignments: [{ assignmentId: "a1", runId: "run-restored", resultPath }],
      };

      await expect(adapter.waitForRunSignal(handle, { timeoutMs: 25 })).resolves.toBe("completed");
      await expect(adapter.getRunResult(handle)).resolves.toBe("restored output");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["cancelRun", "cancelled", "Cancelled by user"],
    ["stopRun", "paused", "Stopped by user; continuation available"],
  ] as const)("%s writes terminal state through restored handle paths", async (method, expectedState, expectedSummary) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const asyncDir = path.join(root, "restored-async");
      const resultPath = path.join(root, "restored-results", `${method}.json`);
      await mkdir(asyncDir, { recursive: true });
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(path.join(asyncDir, "status.json"), JSON.stringify({
        runId: "run-restored",
        state: "running",
        steps: [
          { id: "done", status: "completed", agent: "delegate" },
          { id: "skipped", status: "skipped", agent: "delegate" },
          { id: "active", status: "running", agent: "delegate" },
        ],
      }), "utf8");
      await writeFile(resultPath, JSON.stringify({ runId: "run-restored", state: "running", summary: "old" }), "utf8");

      const adapter = new PiRunnerAdapter({
        piBin: "true",
        asyncDirRootOverride: path.join(root, "unused-async-root"),
        resultsDirOverride: path.join(root, "unused-results-root"),
      });
      const handle: SubagentRunHandle = {
        runId: "run-restored",
        asyncId: "run-restored",
        asyncDir,
        resultPath,
        assignments: [
          { assignmentId: "done", runId: "run-restored", resultPath },
          { assignmentId: "skipped", runId: "run-restored", resultPath },
          { assignmentId: "active", runId: "run-restored", resultPath },
        ],
      };

      await expect(adapter[method](handle, { cwd: process.cwd(), sessionId: "test", pi: {} as never })).resolves.toBe(true);

      const status = JSON.parse(await readFile(path.join(asyncDir, "status.json"), "utf8"));
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      expect(status.state).toBe(expectedState);
      expect(status.steps).toEqual([
        expect.objectContaining({ id: "done", status: "completed" }),
        expect.objectContaining({ id: "skipped", status: "skipped" }),
        expect.objectContaining({ id: "active", status: expectedState }),
      ]);
      expect(result).toMatchObject({ runId: "run-restored", state: expectedState, success: false, summary: expectedSummary });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
