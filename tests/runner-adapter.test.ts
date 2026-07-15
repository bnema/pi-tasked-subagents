import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { ensureTaskGraphRequest } from "../src/launcher/interface.js";
import { readProcessStartTime } from "../src/launcher/process-identity.mjs";
import { PiRunnerAdapter } from "../src/launcher/pi-runner-adapter.js";
import type { SubagentRunHandle } from "../src/types.js";

async function pollUntil(check: () => boolean | Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

async function withLaunchedAdapter(runId: string, result: unknown, testBody: (adapter: PiRunnerAdapter, handle: SubagentRunHandle) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
  try {
    const asyncRoot = path.join(root, "async");
    const resultsRoot = path.join(root, "results");
    const adapter = new PiRunnerAdapter({ piBin: "true", dataRoot: root, asyncDirRootOverride: asyncRoot, resultsDirOverride: resultsRoot });
    const handle = await adapter.launchTaskGraph({
      runId,
      title: "Run",
      taskSummary: "Run",
      tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
    }, { cwd: process.cwd(), sessionId: "test", pi: {} as never });
    await writeFile(handle.resultPath, JSON.stringify(result), "utf8");
    await testBody(adapter, handle);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("PiRunnerAdapter task graph boundary", () => {
  test("isolates same-run launches by durable result identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const sleeper = path.join(root, "sleeper.sh");
      await writeFile(sleeper, "#!/bin/sh\nsleep 30\n", "utf8");
      await chmod(sleeper, 0o700);
      const ids = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"];
      const adapter = new PiRunnerAdapter({
        piBin: sleeper,
        dataRoot: root,
        resultIdFactory: () => ids.shift() ?? "cccccccccccccccccccccccccccccccc",
      });
      const request = {
        runId: "same-run",
        title: "Run",
        taskSummary: "Run",
        tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
      };
      const ctx = { cwd: process.cwd(), sessionId: "session-a", pi: {} as never };
      const first = await adapter.launchTaskGraph(request, ctx);
      const second = await adapter.launchTaskGraph(request, ctx);

      expect(second.resultId).not.toBe(first.resultId);
      expect(second.asyncDir).not.toBe(first.asyncDir);
      expect(JSON.parse(await readFile(path.join(first.asyncDir, "config.json"), "utf8"))).toMatchObject({ resultId: first.resultId, resultPath: first.resultPath });
      expect(JSON.parse(await readFile(path.join(second.asyncDir, "config.json"), "utf8"))).toMatchObject({ resultId: second.resultId, resultPath: second.resultPath });

      await pollUntil(() => adapter.isRunAlive(first));
      await pollUntil(() => adapter.isRunAlive(second));
      await pollUntil(async () => await readFile(path.join(second.asyncDir, "status.json"), "utf8").then(() => true, () => false));
      await expect(adapter.stopRun(first, ctx)).resolves.toBe(true);
      expect(JSON.parse(await readFile(first.resultPath, "utf8"))).toMatchObject({ resultId: first.resultId, state: "paused" });
      await expect(readFile(first.resultReservationPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(second.resultPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(second.resultReservationPath, "utf8")).resolves.toContain(second.resultId);
      await expect(adapter.isRunAlive(second)).resolves.toBe(true);
      expect(JSON.parse(await readFile(path.join(second.asyncDir, "status.json"), "utf8"))).not.toMatchObject({ state: "paused" });

      await adapter.cancelRun(second, ctx);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("allocates a random session-scoped immutable result identity before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const resultIds = ["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"];
      const adapter = new PiRunnerAdapter({
        piBin: "true",
        dataRoot: root,
        resultIdFactory: () => resultIds.shift() ?? "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
      const request = (runId: string) => ({
        runId,
        title: "Run",
        taskSummary: "Run",
        tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
      });

      const first = await adapter.launchTaskGraph(request("same-run"), { cwd: process.cwd(), sessionId: "session-a", pi: {} as never });
      const second = await adapter.launchTaskGraph(request("different-run"), { cwd: process.cwd(), sessionId: "session-a", pi: {} as never });

      expect(first).toMatchObject({
        resultId: "0123456789abcdef0123456789abcdef",
        resultPath: path.join(root, "results", "session-a", "0123456789abcdef0123456789abcdef.json"),
        resultReservationPath: path.join(root, "results", "session-a", "0123456789abcdef0123456789abcdef.json.reservation"),
      });
      expect(second.resultPath).not.toBe(first.resultPath);
      expect(first.resultPath).not.toContain("same-run");
      expect(JSON.parse(await readFile(first.resultReservationPath, "utf8"))).toEqual({
        sessionId: "session-a",
        runId: "same-run",
        resultId: first.resultId,
      });
      const config = JSON.parse(await readFile(path.join(first.asyncDir, "config.json"), "utf8"));
      expect(config).toMatchObject({
        sessionId: "session-a",
        resultId: first.resultId,
        resultPath: first.resultPath,
        resultReservationPath: first.resultReservationPath,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps result reservation in its pinned session directory after a symlink swap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-outside-"));
    try {
      const sessionDirectory = path.join(root, "results", "session-a");
      const adapter = new PiRunnerAdapter({
        piBin: "true",
        dataRoot: root,
        resultIdFactory: () => "0123456789abcdef0123456789abcdef",
        storageMutationHook: async (operation) => {
          if (operation !== "reserve-result") return;
          await rename(sessionDirectory, `${sessionDirectory}-real`);
          await symlink(outside, sessionDirectory);
        },
      });
      await expect(adapter.launchTaskGraph({
        runId: "run-1", title: "Run", taskSummary: "Run",
        tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
      }, { cwd: process.cwd(), sessionId: "session-a", pi: {} as never })).rejects.toThrow(/symlink|storage/i);

      expect(await readdir(outside)).toEqual([]);
      // Failure cleanup retains the original dirfd and removes its reservation,
      // rather than following the swapped session-directory spelling.
      await expect(readFile(path.join(`${sessionDirectory}-real`, "0123456789abcdef0123456789abcdef.json.reservation"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("retries result identity collisions and rejects unsafe session IDs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const collision = "11111111111111111111111111111111";
      const winner = "22222222222222222222222222222222";
      const collisionPath = path.join(root, "results", "session-a", `${collision}.json.reservation`);
      await mkdir(path.dirname(collisionPath), { recursive: true });
      await writeFile(collisionPath, "reserved", "utf8");
      const resultIds = [collision, winner];
      const adapter = new PiRunnerAdapter({ piBin: "true", dataRoot: root, resultIdFactory: () => resultIds.shift() ?? winner });
      const request = {
        runId: "run-1",
        title: "Run",
        taskSummary: "Run",
        tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
      };

      await expect(adapter.launchTaskGraph(request, { cwd: process.cwd(), sessionId: "../escape", pi: {} as never })).rejects.toThrow("Unsafe session ID");
      await expect(adapter.launchTaskGraph(request, { cwd: process.cwd(), sessionId: "session-a", pi: {} as never })).resolves.toMatchObject({ resultId: winner });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(["requireRunPaths", "buildChildren"] as const)("releases the durable reservation when post-reservation %s fails", async (method) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    const resultId = "0123456789abcdef0123456789abcdef";
    try {
      const adapter = new PiRunnerAdapter({ piBin: "true", dataRoot: root, resultIdFactory: () => resultId });
      const internals = adapter as unknown as Record<string, () => unknown>;
      internals[method] = () => { throw new Error(`forced ${method} failure`); };
      await expect(adapter.launchTaskGraph({
        runId: "run-reservation-release", title: "Run", taskSummary: "Run",
        tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
      }, { cwd: process.cwd(), sessionId: "test", pi: {} as never })).rejects.toThrow(`forced ${method} failure`);
      await expect(readFile(path.join(root, "results", "test", `${resultId}.json.reservation`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("removes a tracked adapter launch when its runner child exits", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const adapter = new PiRunnerAdapter({ piBin: "true", dataRoot: root });
      await adapter.launchTaskGraph({
        runId: "run-cleanup", title: "Run", taskSummary: "Run",
        tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
      }, { cwd: process.cwd(), sessionId: "test", pi: {} as never });
      await pollUntil(() => (adapter as unknown as { trackedLaunches: Map<string, unknown> }).trackedLaunches.size === 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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

      const handle = await adapter.launchTaskGraph({
        runId: "run-blank-cwd",
        title: "Run",
        taskSummary: "Run",
        cwd: "   ",
        tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
      }, { cwd: runtimeCwd, sessionId: "test", pi: {} as never });

      const config = JSON.parse(await readFile(path.join(handle.asyncDir, "config.json"), "utf8"));
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

      const config = JSON.parse(await readFile(path.join(handle.asyncDir, "config.json"), "utf8"));
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
        legacy: true,
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
        legacy: true,
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

  test("rejects a durable result path override instead of reading it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const overrideResultPath = path.join(root, "override-results", "run-override.json");
      const adapter = new PiRunnerAdapter({ piBin: "true", dataRoot: root });
      const handle = await adapter.launchTaskGraph({
        runId: "run-override",
        title: "Run",
        taskSummary: "Run",
        tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
      }, { cwd: process.cwd(), sessionId: "test", pi: {} as never });
      await mkdir(path.dirname(overrideResultPath), { recursive: true });
      await writeFile(handle.resultPath, JSON.stringify({ rawOutput: "durable path" }), "utf8");
      await writeFile(overrideResultPath, JSON.stringify({ rawOutput: "override path" }), "utf8");

      await expect(adapter.getRunResult({ ...handle, resultPath: overrideResultPath })).resolves.toBeUndefined();
      await expect(adapter.getRunResult(handle)).resolves.toBe("durable path");
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
      const adapter = new PiRunnerAdapter({ piBin: "true", dataRoot: root });
      const ref = await adapter.launchTaskGraph({
        runId: "run-1",
        title: "Run",
        taskSummary: "Run",
        tasks: [{ assignmentId: "a1", taskRunId: "task-run-1", groupId: "main", taskId: "t1", agent: "delegate", prompt: "do", taskSummary: "do" }],
      }, { cwd: process.cwd(), sessionId: "test", pi: {} as never });

      expect(ref).toMatchObject({
        runId: "run-1",
        asyncId: "run-1",
        sessionId: "test",
        asyncDir: expect.stringMatching(new RegExp(`^${path.join(root, "runs", "test").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/[a-f0-9]{32}$`, "u")),
        resultId: expect.stringMatching(/^[a-f0-9]{32}$/u),
        resultPath: expect.stringMatching(new RegExp(`^${path.join(root, "results", "test").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/[a-f0-9]{32}\\.json$`, "u")),
        resultReservationPath: expect.stringMatching(/\.reservation$/u),
        assignments: [{ assignmentId: "a1", runId: "run-1", resultPath: expect.any(String) }],
      });
      const config = JSON.parse(await readFile(path.join(ref.asyncDir, "config.json"), "utf8"));
      expect(config.mode).toBe("task_graph");
      expect(config.children[0].id).toBe("a1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed for a restored durable handle with attacker-controlled external paths and PIDs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100000)"], { stdio: "ignore" });
    try {
      const resultId = "0123456789abcdef0123456789abcdef";
      const externalDir = path.join(root, "attacker-controlled");
      const externalResultPath = path.join(externalDir, "result.json");
      const externalReservationPath = `${externalResultPath}.reservation`;
      await mkdir(externalDir, { recursive: true });
      await writeFile(path.join(externalDir, "status.json"), JSON.stringify({
        runId: "run-restored",
        state: "running",
        pid: child.pid,
        steps: [{ id: "a1", status: "running", pid: child.pid }],
      }), "utf8");
      await writeFile(externalResultPath, JSON.stringify({ state: "complete", rawOutput: "attacker output" }), "utf8");
      await writeFile(externalReservationPath, JSON.stringify({ sessionId: "session-a", runId: "run-restored", resultId }), "utf8");
      const originalStatus = await readFile(path.join(externalDir, "status.json"), "utf8");
      const originalResult = await readFile(externalResultPath, "utf8");
      const adapter = new PiRunnerAdapter({ piBin: "true", dataRoot: path.join(root, "application-data") });
      const handle: SubagentRunHandle = {
        runId: "run-restored",
        asyncId: "run-restored",
        sessionId: "session-a",
        asyncDir: externalDir,
        resultId,
        resultPath: externalResultPath,
        resultReservationPath: externalReservationPath,
        assignments: [{ assignmentId: "a1", runId: "run-restored", resultPath: externalResultPath }],
      };

      await expect(adapter.waitForRunSignal(handle, { timeoutMs: 25 })).resolves.toBe("failed");
      await expect(adapter.getRunResult(handle)).resolves.toBeUndefined();
      await expect(adapter.isRunAlive(handle)).resolves.toBe(false);
      await expect(adapter.stopRun(handle, { cwd: process.cwd(), sessionId: "session-a", pi: {} as never })).resolves.toBe(false);
      await expect(adapter.cancelRun(handle, { cwd: process.cwd(), sessionId: "session-a", pi: {} as never })).resolves.toBe(false);
      await expect(readFile(path.join(externalDir, "status.json"), "utf8")).resolves.toBe(originalStatus);
      await expect(readFile(externalResultPath, "utf8")).resolves.toBe(originalResult);
      await expect(readFile(externalReservationPath, "utf8")).resolves.toContain(resultId);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
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
        legacy: true,
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

  test("waits for result file after terminal status appears", async () => {
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

      const adapter = new PiRunnerAdapter({
        piBin: "true",
        asyncDirRootOverride: path.join(root, "unused-async-root"),
        resultsDirOverride: path.join(root, "unused-results-root"),
      });
      const handle: SubagentRunHandle = {
        runId: "run-restored",
        asyncId: "run-restored",
        legacy: true,
        asyncDir,
        resultPath,
        assignments: [{ assignmentId: "a1", runId: "run-restored", resultPath }],
      };

      await expect(adapter.waitForRunSignal(handle, { timeoutMs: 25 })).resolves.toBe("attention");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    ["cancelRun", "cancelled", "Cancelled by user"],
    ["stopRun", "paused", "Stopped by user; continuation available"],
  ] as const)("%s publishes terminal state through the adapter-owned reservation", async (method, expectedState, expectedSummary) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const resultId = "0123456789abcdef0123456789abcdef";
      const asyncDir = path.join(root, "runs", "test", resultId);
      const resultPath = path.join(root, "results", "test", `${resultId}.json`);
      const resultReservationPath = `${resultPath}.reservation`;
      await mkdir(asyncDir, { recursive: true });
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(resultReservationPath, JSON.stringify({ sessionId: "test", runId: "run-restored", resultId }), "utf8");
      await writeFile(path.join(asyncDir, "status.json"), JSON.stringify({
        runId: "run-restored",
        state: "running",
        steps: [
          { id: "done", status: "completed", agent: "delegate" },
          { id: "skipped", status: "skipped", agent: "delegate" },
          { id: "active", status: "running", agent: "delegate" },
        ],
      }), "utf8");

      const adapter = new PiRunnerAdapter({ piBin: "true", dataRoot: root });
      const handle: SubagentRunHandle = {
        runId: "run-restored",
        asyncId: "run-restored",
        sessionId: "test",
        asyncDir,
        resultId,
        resultPath,
        resultReservationPath,
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
      expect(result).toMatchObject({ sessionId: "test", runId: "run-restored", resultId, state: expectedState, success: false, summary: expectedSummary });
      await expect(readFile(resultReservationPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never signals a restored PID entry without its matching start identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100000)"], { stdio: "ignore" });
    try {
      const resultId = "0123456789abcdef0123456789abcdef";
      const asyncDir = path.join(root, "runs", "test", resultId);
      const resultPath = path.join(root, "results", "test", `${resultId}.json`);
      await mkdir(asyncDir, { recursive: true });
      await mkdir(path.dirname(resultPath), { recursive: true });
      await writeFile(`${resultPath}.reservation`, JSON.stringify({ sessionId: "test", runId: "run-stale-pid", resultId }), "utf8");
      await writeFile(path.join(asyncDir, "status.json"), JSON.stringify({
        runId: "run-stale-pid", state: "running", pid: child.pid, pidStartTime: "0",
        steps: [{ id: "a1", status: "running", pid: child.pid }],
      }), "utf8");
      const handle: SubagentRunHandle = {
        runId: "run-stale-pid", asyncId: "run-stale-pid", sessionId: "test", asyncDir, resultId,
        resultPath, resultReservationPath: `${resultPath}.reservation`, assignments: [],
      };
      const adapter = new PiRunnerAdapter({ piBin: "true", dataRoot: root });
      await expect(adapter.isRunAlive(handle)).resolves.toBe(false);
      await expect(adapter.stopRun(handle, { cwd: process.cwd(), sessionId: "test", pi: {} as never })).resolves.toBe(true);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires a matching PID start identity for recorded process liveness", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-test-"));
    try {
      const asyncRoot = path.join(root, "async");
      const resultsRoot = path.join(root, "results");
      const runDir = path.join(asyncRoot, "run-alive");
      await mkdir(runDir, { recursive: true });
      await mkdir(resultsRoot, { recursive: true });

      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100000)"], { stdio: "ignore" });
      const deadPid = child.pid ?? -1;
      child.kill("SIGKILL");
      await new Promise((resolve) => child.on("exit", resolve));

      const adapter = new PiRunnerAdapter({ piBin: "true", asyncDirRootOverride: asyncRoot, resultsDirOverride: resultsRoot });
      const statusPath = path.join(runDir, "status.json");
      const handle: SubagentRunHandle = {
        runId: "run-alive",
        asyncId: "run-alive",
        legacy: true,
        asyncDir: runDir,
        resultPath: path.join(resultsRoot, "run-alive.json"),
        assignments: [],
      };

      const startTime = await readProcessStartTime(process.pid);
      expect(startTime).toMatch(/^\d+$/u);
      await writeFile(statusPath, JSON.stringify({ runId: "run-alive", state: "running", steps: [{ id: "a1", status: "running", pid: process.pid }] }), "utf8");
      await expect(adapter.isRunAlive(handle)).resolves.toBe(false);

      await writeFile(statusPath, JSON.stringify({ runId: "run-alive", state: "running", steps: [{ id: "a1", status: "running", pid: process.pid, pidStartTime: startTime }] }), "utf8");
      await expect(adapter.isRunAlive(handle)).resolves.toBe(true);

      await writeFile(statusPath, JSON.stringify({ runId: "run-alive", state: "running", pid: deadPid, pidStartTime: "0", steps: [{ id: "a1", status: "running", pid: deadPid, pidStartTime: "0" }] }), "utf8");
      await expect(adapter.isRunAlive(handle)).resolves.toBe(false);

      await rm(statusPath);
      await expect(adapter.isRunAlive(handle)).resolves.toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
