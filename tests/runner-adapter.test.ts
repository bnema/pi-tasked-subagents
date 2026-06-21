import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ensureTaskGraphRequest } from "../src/launcher/interface.js";
import { PiRunnerAdapter } from "../src/launcher/pi-runner-adapter.js";

async function withLaunchedAdapter(runId: string, result: unknown, testBody: (adapter: PiRunnerAdapter) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
  try {
    const asyncRoot = path.join(root, "async");
    const resultsRoot = path.join(root, "results");
    const adapter = new PiRunnerAdapter({ piBin: "true", asyncDirRootOverride: asyncRoot, resultsDirOverride: resultsRoot });
    await adapter.launchTaskGraph({
      runId,
      title: "Run",
      taskSummary: "Run",
      tasks: [{ assignmentId: "a1", phaseId: "p1", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
    }, { cwd: process.cwd(), sessionId: "test", pi: {} as never });
    await writeFile(path.join(resultsRoot, `${runId}.json`), JSON.stringify(result), "utf8");
    await testBody(adapter);
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
      tasks: [{ phaseId: "p1", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
    } as never)).toThrow("Task assignment id is required");
  });

  test("rejects unsafe run ids", async () => {
    const adapter = new PiRunnerAdapter({ piBin: "true" });
    await expect(adapter.launchTaskGraph({
      runId: "../escape",
      title: "Bad",
      taskSummary: "Bad",
      tasks: [{ assignmentId: "a1", phaseId: "p1", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
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
      const status = await adapter.waitForRunSignal("run-1", { timeoutMs: 25 });

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
      const status = await adapter.waitForRunSignal("run-1", {
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
    await withLaunchedAdapter("run-raw", { rawOutput: "raw report", summary: "summary" }, async (adapter) => {
      await expect(adapter.getRunResult("run-raw")).resolves.toBe("raw report");
    });
  });

  test("multi-result files return step summaries and output metadata", async () => {
    await withLaunchedAdapter("run-multi", {
      results: [
        { stepId: "a1", rawOutput: "raw one", output: "output one", summary: "one", success: true },
        { stepId: "a2", output: "output two", summary: "two", error: "boom", success: false },
      ],
    }, async (adapter) => {
      const raw = await adapter.getRunResult("run-multi");
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
    await withLaunchedAdapter(runId, result, async (adapter) => {
      await expect(adapter.getRunResult(runId)).resolves.toBe(expected);
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
        tasks: [{ assignmentId: "a1", phaseId: "p1", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
      }, { cwd: process.cwd(), sessionId: "test", pi: {} as never });

      expect(ref.assignments[0]).toMatchObject({ assignmentId: "a1", runId: "run-1" });
      const config = JSON.parse(await readFile(path.join(asyncRoot, "run-1", "config.json"), "utf8"));
      expect(config.mode).toBe("task_graph");
      expect(config.children[0].id).toBe("a1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
