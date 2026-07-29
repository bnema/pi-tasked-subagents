import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, beforeEach } from "vitest";

import { publishTerminalResult, verifyResultReservation } from "../src/launcher/result-files.mjs";
import {
  applyPublishedTerminalResult,
  armRunnerTermination,
  buildTerminalPublicationPayload,
  buildPiArgs,
  canonicalizeChildResult,
  evaluateTaskGraphCondition,
  getReadyTaskGraphStepIds,
  isTerminalTurnEnd,
  parseStructuredStepOutput,
  renderTaskGraphTemplate,
  renderTerminationSignal,
  recoverTerminalChildExit,
  resetRunnerTerminationForTests,
  runTaskGraph,
  settleOwnedProcessTermination,
  terminateTrackedSteps,
  waitForChildExit,
} from "../src/launcher/direct-runner.mjs";
import {
  MAX_ASSIGNMENT_REPORT_BYTES,
  MAX_RESULT_CHILDREN,
  MAX_RUN_RESULT_BYTES,
} from "../src/defaults.js";
import {
  accumulateUsage,
  emptyUsage,
  mergeAttemptUsages,
  parsePiMessageUsage,
} from "../src/launcher/usage-accumulator.mjs";
import {
  captureProcessIdentity,
  isProcessIdentityAlive,
  terminateProcessIdentity,
} from "../src/launcher/process-identity.mjs";

const fastTerminateOptions = { graceMs: 50, pollMs: 5, forceWaitMs: 200 };

beforeEach(() => {
  resetRunnerTerminationForTests();
});

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs = 2_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("child did not exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function waitForProcessIdentity(pid: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await captureProcessIdentity(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("process identity was not ready");
}

describe("child Pi argument construction", () => {
  test("passes explicit skills while allowing discovery to be disabled", () => {
    const args = buildPiArgs({
      id: "task-1",
      agent: "delegate",
      prompt: "Complete the task.",
      cwd: process.cwd(),
      sessionDir: "/tmp/child-session",
      outputFile: "output.log",
      taskSummary: "Complete the task.",
      skills: ["/repo/.agents/skills/testing", "/repo/.agents/skills/review"],
      inheritSkills: false,
    });

    expect(args).toEqual([
      "--mode", "json",
      "--session-dir", "/tmp/child-session",
      "--no-skills",
      "--skill", "/repo/.agents/skills/testing",
      "--skill", "/repo/.agents/skills/review",
      "Complete the task.",
    ]);
  });
});

describe("terminal child exit recovery", () => {
  test("arms only for terminal Pi turns", () => {
    expect(isTerminalTurnEnd({ type: "turn_end", message: { stopReason: "stop" } })).toBe(true);
    expect(isTerminalTurnEnd({ type: "turn_end", message: { stopReason: "error" } })).toBe(true);
    expect(isTerminalTurnEnd({ type: "turn_end", message: { stopReason: "aborted" } })).toBe(true);
    expect(isTerminalTurnEnd({ type: "turn_end", message: { stopReason: "length" } })).toBe(true);
    expect(isTerminalTurnEnd({ type: "turn_end", message: { stopReason: "toolUse" } })).toBe(false);
    expect(isTerminalTurnEnd({ type: "turn_end" })).toBe(false);
    expect(isTerminalTurnEnd({ type: "message_end", message: { stopReason: "stop" } })).toBe(false);
  });
});

describe("runner process identities", () => {
  test("recovers after a terminal turn when the Pi child does not exit", async () => {
    const childExit = new Promise<number>(() => undefined);
    const terminated: Array<{ pid: number; startTime: string }> = [];

    const recovered = await recoverTerminalChildExit(
      childExit,
      { pid: 42, startTime: "100" },
      {
        graceMs: 1,
        terminate: async (identity) => {
          terminated.push(identity);
          return "exited";
        },
      },
    );

    expect(recovered).toBe(true);
    expect(terminated).toEqual([{ pid: 42, startTime: "100" }]);
  });

  test("does not terminate a Pi child that exits during the terminal grace period", async () => {
    let terminateCalled = false;

    const recovered = await recoverTerminalChildExit(
      Promise.resolve(0),
      { pid: 42, startTime: "100" },
      {
        graceMs: 1,
        terminate: async () => {
          terminateCalled = true;
          return "exited";
        },
      },
    );

    expect(recovered).toBe(false);
    expect(terminateCalled).toBe(false);
  });

  test("registers a child error listener before awaiting process identity I/O", async () => {
    const child = new EventEmitter();
    const exit = waitForChildExit(child);
    child.emit("error", new Error("spawn failed"));
    await expect(exit).rejects.toThrow("spawn failed");
  });

  test("does not signal a PID whose stored start identity is missing or stale", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100000)"], { stdio: "ignore" });
    try {
      const outcomes = await terminateTrackedSteps([{ pid: child.pid }, { pid: child.pid, pidStartTime: "0" }], fastTerminateOptions);
      expect(outcomes).toEqual([{ outcome: "stale" }, { outcome: "stale" }]);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
  });

  test("awaits a child that exits on SIGTERM", async () => {
    const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => process.exit(0))'], { stdio: "ignore" });
    const identity = await captureProcessIdentity(child.pid!);
    expect(identity).toBeDefined();
    const exitPromise = waitForExit(child);
    const outcome = await terminateProcessIdentity(identity!, fastTerminateOptions);
    expect(outcome).toBe("exited");
    await exitPromise;
    expect(await isProcessIdentityAlive(identity!)).toBe(false);
  });

  test("SIGKILLs a child that ignores SIGTERM after the injected grace period", async () => {
    const child = spawn("python3", ["-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(3600)"], { stdio: "ignore" });
    await waitForProcessIdentity(child.pid!);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const identity = await captureProcessIdentity(child.pid!);
    const exitPromise = waitForExit(child);
    const started = Date.now();
    const outcome = await terminateProcessIdentity(identity!, fastTerminateOptions);
    expect(outcome).toBe("forced");
    expect(Date.now() - started).toBeGreaterThanOrEqual(fastTerminateOptions.graceMs);
    expect(Date.now() - started).toBeLessThan(fastTerminateOptions.graceMs + fastTerminateOptions.forceWaitMs + 250);
    await exitPromise;
  });

  test("never signals a stale or reused PID identity", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100000)"], { stdio: "ignore" });
    try {
      const outcome = await terminateProcessIdentity({ pid: child.pid!, startTime: "0" }, fastTerminateOptions);
      expect(outcome).toBe("stale");
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
  });

  test("terminateTrackedSteps awaits verified child death", async () => {
    const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => process.exit(0))'], { stdio: "ignore" });
    const identity = await captureProcessIdentity(child.pid!);
    const exitPromise = waitForExit(child);
    const outcomes = await terminateTrackedSteps([{ pid: identity!.pid, pidStartTime: identity!.startTime }], fastTerminateOptions);
    expect(outcomes).toEqual([{ outcome: "exited" }]);
    await exitPromise;
  });
});

describe("owned process termination settlement", () => {
  test("repeated status discovery finds children recorded after the first scan", async () => {
    const child = spawn("python3", ["-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(3600)"], { stdio: "ignore" });
    await waitForProcessIdentity(child.pid!);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const identity = await captureProcessIdentity(child.pid!);
    const exitPromise = waitForExit(child);
    let reads = 0;
    const settlement = await settleOwnedProcessTermination({
      readStatus: async () => {
        reads += 1;
        if (reads === 1) return { steps: [] };
        return { steps: [{ pid: identity!.pid, pidStartTime: identity!.startTime }] };
      },
      ...fastTerminateOptions,
      discoveryPollMs: 5,
      deadlineMs: 1_000,
    });
    expect(settlement.quiet).toBe(true);
    expect(reads).toBeGreaterThanOrEqual(2);
    await exitPromise;
  });

  test("ignorePids keeps the caller process out of settlement targets", async () => {
    const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => process.exit(0))'], { stdio: "ignore" });
    const identity = await captureProcessIdentity(child.pid!);
    const selfIdentity = await captureProcessIdentity(process.pid);
    expect(selfIdentity).toBeDefined();
    const exitPromise = waitForExit(child);
    const settlement = await settleOwnedProcessTermination({
      readStatus: async () => ({
        pid: selfIdentity!.pid,
        pidStartTime: selfIdentity!.startTime,
        steps: [{ pid: identity!.pid, pidStartTime: identity!.startTime }],
      }),
      ignorePids: [process.pid],
      ...fastTerminateOptions,
      discoveryPollMs: 5,
      deadlineMs: 1_000,
    });
    expect(settlement.quiet).toBe(true);
    expect(await isProcessIdentityAlive(selfIdentity!)).toBe(true);
    await exitPromise;
  });

  test("process discovery and termination waits are bounded by deadline", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100000)"], { stdio: "ignore" });
    const identity = await captureProcessIdentity(child.pid!);
    const deadlineMs = 120;
    const started = Date.now();
    const settlement = await settleOwnedProcessTermination({
      readStatus: async () => ({ steps: [{ pid: identity!.pid, pidStartTime: "0" }] }),
      graceMs: 5,
      pollMs: 5,
      forceWaitMs: 5,
      discoveryPollMs: 5,
      deadlineMs,
    });
    expect(settlement.quiet).toBe(false);
    expect(Date.now() - started).toBeLessThan(deadlineMs + 200);
    expect(() => process.kill(child.pid!, 0)).not.toThrow();
    child.kill("SIGKILL");
    await waitForExit(child);
  });
});

describe("task graph termination guard", () => {
  test("arming termination quiesces the scheduler before any new child can spawn", async () => {
    armRunnerTermination();
    const asyncDir = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-guard-"));
    const statusPath = path.join(asyncDir, "status.json");
    const status = {
      runId: "run-test",
      mode: "task_graph",
      state: "running",
      steps: [
        { index: 0, id: "a", status: "pending" },
        { index: 1, id: "b", status: "pending", dependsOn: ["a"] },
      ],
    };
    const config = {
      runId: "run-test",
      mode: "task_graph",
      piBin: process.execPath,
      asyncDir,
      statusPath,
      children: [
        { id: "a", agent: "delegate", prompt: "noop", cwd: process.cwd(), sessionDir: path.join(asyncDir, "child-0"), outputFile: "a.txt", taskSummary: "a" },
        { id: "b", agent: "delegate", prompt: "noop", cwd: process.cwd(), sessionDir: path.join(asyncDir, "child-1"), outputFile: "b.txt", taskSummary: "b", dependsOn: ["a"] },
      ],
    };
    try {
      const results = await runTaskGraph(config, status);
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.status === "cancelled" || result.status === "skipped")).toBe(true);
      expect(status.steps?.every((step) => step.status === "cancelled" || step.status === "skipped")).toBe(true);
    } finally {
      await rm(asyncDir, { recursive: true, force: true });
    }
  });
});

describe("immutable terminal result publication", () => {
  async function withResultPaths(testBody: (paths: {
    directory: string;
    resultPath: string;
    reservationPath: string;
    expected: { sessionId: string; runId: string; resultId: string };
  }) => Promise<void>) {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-result-"));
    const expected = { sessionId: "session-test", runId: "run-test", resultId: "0123456789abcdef0123456789abcdef" };
    const directory = path.join(root, "results", expected.sessionId);
    await mkdir(directory, { recursive: true });
    const resultPath = path.join(directory, `${expected.resultId}.json`);
    const reservationPath = `${resultPath}.reservation`;
    try {
      await writeFile(reservationPath, JSON.stringify(expected), "utf8");
      await testBody({ directory, resultPath, reservationPath, expected });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  test("rejects noncanonical session IDs and empty run IDs before durable I/O", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-result-"));
    const resultId = "0123456789abcdef0123456789abcdef";
    const resultPath = path.join(root, "results", "session-test", `${resultId}.json`);
    try {
      await expect(publishTerminalResult(resultPath, `${resultPath}.reservation`, {
        sessionId: "../escape", runId: "run-test", resultId,
      }, { state: "failed" })).rejects.toThrow("Unsafe durable result identity");
      await expect(publishTerminalResult(resultPath, `${resultPath}.reservation`, {
        sessionId: "session-test", runId: " ", resultId,
      }, { state: "failed" })).rejects.toThrow("Unsafe durable result identity");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires the adapter-owned reservation and never creates one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-result-"));
    const expected = { sessionId: "session-test", runId: "run-test", resultId: "0123456789abcdef0123456789abcdef" };
    const directory = path.join(root, "results", expected.sessionId);
    await mkdir(directory, { recursive: true });
    const reservationPath = path.join(directory, `${expected.resultId}.json.reservation`);
    try {
      await expect(verifyResultReservation(reservationPath, expected)).rejects.toThrow("reservation");
      await expect(readFile(reservationPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("publishes once and an already-published valid result wins", async () => {
    await withResultPaths(async ({ resultPath, reservationPath, expected }) => {
      const first = await publishTerminalResult(resultPath, reservationPath, expected, { state: "complete", success: true, summary: "first" });
      const second = await publishTerminalResult(resultPath, reservationPath, expected, { state: "cancelled", success: false, summary: "second" });

      expect(first.published).toBe(true);
      expect(second.published).toBe(false);
      expect(JSON.parse(await readFile(resultPath, "utf8"))).toMatchObject({
        ...expected,
        state: "complete",
        success: true,
        summary: "first",
      });
      await expect(readFile(reservationPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  test("concurrent terminal publishers select exactly one immutable winner and clean sibling temps", async () => {
    await withResultPaths(async ({ directory, resultPath, reservationPath, expected }) => {
      const [first, second] = await Promise.all([
        publishTerminalResult(resultPath, reservationPath, expected, { state: "complete", success: true, summary: "completion" }),
        publishTerminalResult(resultPath, reservationPath, expected, { state: "cancelled", success: false, summary: "cancellation" }),
      ]);
      const result = JSON.parse(await readFile(resultPath, "utf8"));

      expect([first.published, second.published].filter(Boolean)).toHaveLength(1);
      expect(["completion", "cancellation"]).toContain(result.summary);
      expect((await readdir(directory)).filter((name) => name.includes(".tmp-")).length).toBe(0);
    });
  });

  test("keeps terminal publication in its pinned session directory after a symlink swap", async () => {
    await withResultPaths(async ({ directory, resultPath, reservationPath, expected }) => {
      const outside = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-outside-"));
      try {
        const published = await publishTerminalResult(resultPath, reservationPath, expected, { state: "complete" }, {
          beforeMutation: async () => {
            await rename(directory, `${directory}-real`);
            await symlink(outside, directory);
          },
        });
        expect(published.published).toBe(true);
        expect(await readdir(outside)).toEqual([]);
        await expect(readFile(path.join(`${directory}-real`, path.basename(resultPath)), "utf8")).resolves.toContain(expected.resultId);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("rejects mismatched reservations without deleting their owner data", async () => {
    await withResultPaths(async ({ directory, resultPath, reservationPath, expected }) => {
      const owner = { ...expected, runId: "other-run" };
      await writeFile(reservationPath, JSON.stringify(owner), "utf8");

      await expect(publishTerminalResult(resultPath, reservationPath, expected, { state: "failed" })).rejects.toThrow("reservation");
      await expect(readFile(reservationPath, "utf8")).resolves.toBe(JSON.stringify(owner));
      expect((await readdir(directory)).filter((name) => name.includes(".tmp-")).length).toBe(0);
    });
  });
});

describe("direct runner task graph internals", () => {
  test("renders dependency outputs into task prompts", () => {
    expect(renderTaskGraphTemplate("Use {{scan.summary}}", {
      scan: { summary: "found issue", output: "details", success: true },
    })).toBe("Use found issue");
  });

  test("parses structured JSON output", () => {
    expect(parseStructuredStepOutput("```json\n{\"summary\":\"ok\"}\n```", "json")).toEqual({ summary: "ok" });
  });

  test("evaluates conditions from structured outputs", () => {
    expect(evaluateTaskGraphCondition("{{triage.structured.runReview}}", {
      triage: { structuredOutput: { runReview: true } },
    })).toBe(true);
  });

  test("derives ready task ids from dependency completion", () => {
    expect(getReadyTaskGraphStepIds([
      { id: "a", status: "completed" },
      { id: "b", status: "pending", dependsOn: ["a"] },
      { id: "c", status: "pending", dependsOn: ["b"] },
    ], 2)).toEqual(["b"]);
  });

  test("uses the immutable terminal winner when writing terminal status", () => {
    expect(applyPublishedTerminalResult({ state: "paused", summary: "loser" }, {
      state: "complete", success: true, summary: "winner", timestamp: 7,
    }, 1)).toMatchObject({ state: "complete", success: true, summary: "winner", endedAt: 7, lastUpdate: 7 });
  });

  test("preserves terminal step statuses on cancellation", () => {
    const signal = renderTerminationSignal({ state: "cancelled", steps: [
      { id: "done", status: "completed" },
      { id: "live", status: "running" },
    ] }, {}, 1);

    const status = signal.status as { steps?: Array<{ status?: string }> };
    expect(status.steps?.map((step) => step.status)).toEqual(["completed", "cancelled"]);
    expect(signal.result.state).toBe("cancelled");
  });
});

function sampleReport(assignmentId: string, summary = "done") {
  return {
    taskRunId: "task-run-1",
    groupId: "main",
    taskId: "t1",
    assignmentId,
    status: "completed",
    summary,
    criteriaEvidence: [{ criteriaIndex: 0, evidence: `${assignmentId} evidence` }],
    artifacts: [],
    followUps: [],
  };
}

function childConfig(id: string) {
  return {
    id,
    agent: "delegate",
    prompt: "noop",
    cwd: process.cwd(),
    sessionDir: `/tmp/session-${id}`,
    outputFile: `output-${id}.log`,
    taskSummary: id,
  };
}

describe("canonical terminal child results", () => {
  test("completed child exposes parsed report once without legacy output fields", () => {
    const report = sampleReport("a1");
    const canonical = canonicalizeChildResult(childConfig("a1"), {
      status: "completed",
      success: true,
      output: JSON.stringify(report),
      summary: report.summary,
      attempts: [{ attempt: 1, success: true, startedAt: 1, endedAt: 2 }],
      toolCount: 3,
    });

    expect(canonical).toMatchObject({
      stepId: "a1",
      agent: "delegate",
      status: "completed",
      summary: "done",
      report,
      toolCount: 3,
      attempts: [{ attempt: 1, success: true, startedAt: 1, endedAt: 2 }],
    });
    expect(canonical).not.toHaveProperty("output");
    expect(canonical).not.toHaveProperty("rawOutput");
    expect(canonical).not.toHaveProperty("artifactPaths");
    expect(canonical).not.toHaveProperty("diagnostic");
    expect(JSON.stringify(canonical).match(/"report"/g)?.length).toBe(1);
  });

  test("failed child keeps bounded diagnostic and omits report on parse failure", () => {
    const canonical = canonicalizeChildResult(childConfig("a1"), {
      status: "failed",
      success: false,
      output: "not a report",
      error: "Expected JSON object",
      attempts: [{ attempt: 1, success: false, error: "Expected JSON object", startedAt: 1, endedAt: 2 }],
    });

    expect(canonical).toMatchObject({
      stepId: "a1",
      status: "failed",
      diagnostic: "Expected JSON object",
      attempts: [{ attempt: 1, success: false, error: "Expected JSON object", startedAt: 1, endedAt: 2 }],
    });
    expect(canonical).not.toHaveProperty("report");
    expect((canonical.attempts as Array<Record<string, unknown>>)[0]).not.toHaveProperty("result");
  });

  test("retried child attempts never embed finalResult", () => {
    const report = sampleReport("a1", "second try");
    const canonical = canonicalizeChildResult(childConfig("a1"), {
      status: "completed",
      success: true,
      output: JSON.stringify(report),
      summary: report.summary,
      attempts: [
        { attempt: 1, success: false, error: "first failed", startedAt: 1, endedAt: 2 },
        { attempt: 2, success: true, startedAt: 3, endedAt: 4 },
      ],
    });

    expect((canonical.attempts as Array<Record<string, unknown>>)).toHaveLength(2);
    for (const attempt of canonical.attempts as Array<Record<string, unknown>>) expect(attempt).not.toHaveProperty("result");
    expect((canonical.report as { summary?: string })?.summary).toBe("second try");
  });

  test("merges usage totals across retried attempts", () => {
    const canonical = canonicalizeChildResult(childConfig("a1"), {
      status: "completed",
      success: true,
      output: JSON.stringify(sampleReport("a1")),
      summary: "done",
      attempts: [
        {
          attempt: 1,
          success: true,
          startedAt: 1,
          endedAt: 2,
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: 15,
            cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
            assistantCalls: 1,
            toolCalls: 1,
            models: ["gpt-4"],
          },
        },
        {
          attempt: 2,
          success: true,
          startedAt: 3,
          endedAt: 4,
          usage: {
            input: 20,
            output: 10,
            cacheRead: 1,
            cacheWrite: 0,
            reasoning: 0,
            totalTokens: 31,
            cost: { input: 0.02, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.05 },
            assistantCalls: 1,
            toolCalls: 0,
            models: ["gpt-4.1"],
          },
        },
      ],
    });

    expect(canonical.usage).toMatchObject({
      input: 30,
      output: 15,
      cacheRead: 1,
      totalTokens: 46,
      assistantCalls: 2,
      toolCalls: 1,
      models: ["gpt-4", "gpt-4.1"],
      cost: { total: 0.08 },
    });
  });

  test("skipped and cancelled children keep canonical shape without report files", () => {
    expect(canonicalizeChildResult(childConfig("skip"), {
      status: "skipped",
      success: true,
      summary: "Skipped because when condition evaluated false",
      attempts: [],
      skipped: true,
    })).toMatchObject({
      stepId: "skip",
      status: "skipped",
      summary: "Skipped because when condition evaluated false",
      attempts: [],
    });

    expect(canonicalizeChildResult(childConfig("cancel"), {
      status: "cancelled",
      success: false,
      summary: "Cancelled",
      attempts: [],
      skipped: true,
    })).toMatchObject({
      stepId: "cancel",
      status: "cancelled",
      summary: "Cancelled",
      attempts: [],
    });
  });

  test("oversized assignment report fails closed without publishing truncated report", () => {
    const report = sampleReport("a1", "x".repeat(MAX_ASSIGNMENT_REPORT_BYTES));
    const canonical = canonicalizeChildResult(childConfig("a1"), {
      status: "completed",
      success: true,
      output: JSON.stringify(report),
      summary: report.summary,
      attempts: [],
    });

    expect(canonical).toMatchObject({
      status: "failed",
      diagnostic: `Assignment report exceeds ${MAX_ASSIGNMENT_REPORT_BYTES} bytes`,
    });
    expect(canonical).not.toHaveProperty("report");
  });

  test("root publication fails closed when payload exceeds bounds", () => {
    const report = sampleReport("a1");
    const children = Array.from({ length: MAX_RESULT_CHILDREN + 1 }, (_, index) => canonicalizeChildResult(childConfig(`a${index}`), {
      status: "completed",
      success: true,
      output: JSON.stringify({ ...report, assignmentId: `a${index}` }),
      summary: "done",
      attempts: [],
    }));
    const tooMany = buildTerminalPublicationPayload(children);
    expect(tooMany.success).toBe(false);
    expect(tooMany.state).toBe("failed");
    expect(tooMany.results).toBeUndefined();
    expect(tooMany.summary).toContain("children");

    const hugeChild = canonicalizeChildResult(childConfig("huge"), {
      status: "completed",
      success: true,
      output: JSON.stringify(sampleReport("huge", "y".repeat(MAX_ASSIGNMENT_REPORT_BYTES - 200))),
      summary: "big",
      attempts: [],
    });
    const payload = buildTerminalPublicationPayload([hugeChild]);
    expect(Buffer.byteLength(JSON.stringify(payload), "utf8")).toBeLessThanOrEqual(MAX_RUN_RESULT_BYTES + 512);
    if (Buffer.byteLength(JSON.stringify({ ...payload, results: [hugeChild, hugeChild] }), "utf8") > MAX_RUN_RESULT_BYTES) {
      const oversized = buildTerminalPublicationPayload([hugeChild, hugeChild]);
      expect(oversized.success).toBe(false);
      expect(oversized.results).toBeUndefined();
    }
  });
});

describe("assignment usage accumulation", () => {
  test("parses Pi message usage without inferring cost totals", () => {
    expect(parsePiMessageUsage({
      input: 10,
      output: 5,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 16,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    })).toMatchObject({ totalTokens: 16, cost: { total: 0.03 } });
    expect(parsePiMessageUsage({
      input: 10,
      output: 5,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 16,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0 },
      inferred: true,
    })).toBeUndefined();
  });

  test("sums per-message totalTokens instead of recomputing from token fields", () => {
    const merged = mergeAttemptUsages([{
      usage: accumulateUsage(emptyUsage(), {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 99,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        assistantCalls: 1,
        toolCalls: 0,
        models: [],
      }),
    }]);
    expect(merged?.totalTokens).toBe(99);
    expect(merged?.input).toBe(1);
  });
});

async function runFakePiTask(scriptBody: string, runId: string) {
  const asyncDir = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-fake-pi-"));
  const report = sampleReport("a1");
  const fakePi = path.join(asyncDir, "fake-pi.mjs");
  await writeFile(fakePi, `#!/usr/bin/env node
const report = ${JSON.stringify(report)};
${scriptBody}
`, "utf8");
  await chmod(fakePi, 0o700);
  const statusPath = path.join(asyncDir, "status.json");
  const resultPath = path.join(asyncDir, "result.json");
  const reservationPath = `${resultPath}.reservation`;
  const status = {
    runId,
    mode: "task_graph",
    state: "running",
    steps: [{ index: 0, id: "a1", status: "pending" }],
  };
  const config = {
    runId,
    sessionId: "session-test",
    mode: "task_graph",
    piBin: fakePi,
    asyncDir,
    statusPath,
    eventsPath: path.join(asyncDir, "events.jsonl"),
    resultPath,
    resultReservationPath: reservationPath,
    storageRoot: asyncDir,
    children: [{
      ...childConfig("a1"),
      sessionDir: path.join(asyncDir, "child-0"),
      outputFile: "output-0.log",
    }],
  };
  await writeFile(reservationPath, JSON.stringify({
    sessionId: "session-test",
    runId,
    resultId: "00112233445566778899aabbccddeeff",
  }), "utf8");

  try {
    return { results: await runTaskGraph(config, status), status, report };
  } finally {
    await rm(asyncDir, { recursive: true, force: true });
  }
}

describe("canonical task graph integration", () => {
  test("runTaskGraph publishes canonical children and never writes output-N.log", async () => {
    const asyncDir = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-canonical-"));
    const report = sampleReport("a1");
    const fakePi = path.join(asyncDir, "fake-pi.mjs");
    await writeFile(fakePi, `#!/usr/bin/env node
const report = ${JSON.stringify(report)};
console.log(JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: JSON.stringify(report) }] },
}));
`, "utf8");
    await chmod(fakePi, 0o700);
    const statusPath = path.join(asyncDir, "status.json");
    const resultPath = path.join(asyncDir, "result.json");
    const reservationPath = `${resultPath}.reservation`;
    const status = {
      runId: "run-canonical",
      mode: "task_graph",
      state: "running",
      steps: [{ index: 0, id: "a1", status: "pending" }],
    };
    const config = {
      runId: "run-canonical",
      sessionId: "session-test",
      mode: "task_graph",
      piBin: fakePi,
      asyncDir,
      statusPath,
      eventsPath: path.join(asyncDir, "events.jsonl"),
      resultPath,
      resultReservationPath: reservationPath,
      storageRoot: asyncDir,
      children: [{
        ...childConfig("a1"),
        sessionDir: path.join(asyncDir, "child-0"),
        outputFile: "output-0.log",
      }],
    };
    await mkdir(path.dirname(resultPath), { recursive: true });
    await writeFile(reservationPath, JSON.stringify({
      sessionId: "session-test",
      runId: "run-canonical",
      resultId: "0123456789abcdef0123456789abcdef",
    }), "utf8");

    try {
      const results = await runTaskGraph(config, status);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        stepId: "a1",
        status: "completed",
        report,
      });
      expect(results[0]).not.toHaveProperty("rawOutput");
      await expect(readFile(path.join(asyncDir, "output-0.log"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(asyncDir, { recursive: true, force: true });
    }
  });

  test("recovers a Pi child that stays alive after emitting a terminal turn", async () => {
    const asyncDir = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-terminal-exit-"));
    const report = sampleReport("a1");
    const fakePi = path.join(asyncDir, "fake-pi.mjs");
    await writeFile(fakePi, `#!/usr/bin/env node
const report = ${JSON.stringify(report)};
const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(report) }] };
console.log(JSON.stringify({ type: "message_end", message }));
console.log(JSON.stringify({ type: "turn_end", message }));
setInterval(() => {}, 60_000);
`, "utf8");
    await chmod(fakePi, 0o700);
    const statusPath = path.join(asyncDir, "status.json");
    const resultPath = path.join(asyncDir, "result.json");
    const reservationPath = `${resultPath}.reservation`;
    const status = {
      runId: "run-terminal-exit",
      mode: "task_graph",
      state: "running",
      steps: [{ index: 0, id: "a1", status: "pending" }],
    };
    const config = {
      runId: "run-terminal-exit",
      sessionId: "session-test",
      mode: "task_graph",
      piBin: fakePi,
      asyncDir,
      statusPath,
      eventsPath: path.join(asyncDir, "events.jsonl"),
      resultPath,
      resultReservationPath: reservationPath,
      storageRoot: asyncDir,
      children: [{
        ...childConfig("a1"),
        sessionDir: path.join(asyncDir, "child-0"),
        outputFile: "output-0.log",
      }],
    };
    await writeFile(reservationPath, JSON.stringify({
      sessionId: "session-test",
      runId: "run-terminal-exit",
      resultId: "fedcba9876543210fedcba9876543210",
    }), "utf8");

    try {
      const results = await runTaskGraph(config, status);

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ stepId: "a1", status: "completed", report });
      expect(status.steps[0]).toMatchObject({
        status: "completed",
        exitCode: 0,
        lastActionSummary: "terminal child exit recovered",
      });
    } finally {
      await rm(asyncDir, { recursive: true, force: true });
    }
  }, 10_000);

  test("preserves a natural nonzero exit after a terminal turn", async () => {
    const { status } = await runFakePiTask(`
const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(report) }] };
console.log(JSON.stringify({ type: "message_end", message }));
console.log(JSON.stringify({ type: "turn_end", message }));
process.exitCode = 7;
`, "run-terminal-nonzero");

    expect(status.steps[0]).toMatchObject({
      status: "failed",
      exitCode: 7,
      error: "pi exited with code 7",
    });
  });

  test("does not terminate a child after a nonterminal tool-use turn", async () => {
    const { results, report } = await runFakePiTask(`
const toolTurn = { role: "assistant", stopReason: "toolUse", content: [] };
console.log(JSON.stringify({ type: "turn_end", message: toolTurn }));
setTimeout(() => {
  const message = { role: "assistant", stopReason: "stop", content: [{ type: "text", text: JSON.stringify(report) }] };
  console.log(JSON.stringify({ type: "message_end", message }));
  console.log(JSON.stringify({ type: "turn_end", message }));
}, 2_200);
`, "run-tool-use-before-terminal");

    expect(results[0]).toMatchObject({ stepId: "a1", status: "completed", report });
  }, 10_000);
});
