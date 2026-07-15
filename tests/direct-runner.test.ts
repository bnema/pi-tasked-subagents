import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { publishTerminalResult, verifyResultReservation } from "../src/launcher/result-files.mjs";
import {
  applyPublishedTerminalResult,
  evaluateTaskGraphCondition,
  getReadyTaskGraphStepIds,
  parseStructuredStepOutput,
  renderTaskGraphTemplate,
  renderTerminationSignal,
  terminateTrackedSteps,
  waitForChildExit,
} from "../src/launcher/direct-runner.mjs";

describe("runner process identities", () => {
  test("registers a child error listener before awaiting process identity I/O", async () => {
    const child = new EventEmitter();
    const exit = waitForChildExit(child);
    child.emit("error", new Error("spawn failed"));
    await expect(exit).rejects.toThrow("spawn failed");
  });

  test("does not signal a PID whose stored start identity is missing or stale", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 100000)"], { stdio: "ignore" });
    try {
      await terminateTrackedSteps([{ pid: child.pid }, { pid: child.pid, pidStartTime: "0" }]);
      expect(() => process.kill(child.pid!, 0)).not.toThrow();
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
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
