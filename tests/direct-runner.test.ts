import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { publishTerminalResult, verifyResultReservation } from "../src/launcher/result-files.mjs";
import {
  evaluateTaskGraphCondition,
  getReadyTaskGraphStepIds,
  parseStructuredStepOutput,
  renderTaskGraphTemplate,
  renderTerminationSignal,
} from "../src/launcher/direct-runner.mjs";

describe("immutable terminal result publication", () => {
  async function withResultPaths(testBody: (paths: {
    directory: string;
    resultPath: string;
    reservationPath: string;
    expected: { sessionId: string; runId: string; resultId: string };
  }) => Promise<void>) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-result-"));
    const expected = { sessionId: "session-test", runId: "run-test", resultId: "0123456789abcdef0123456789abcdef" };
    const resultPath = path.join(directory, `${expected.resultId}.json`);
    const reservationPath = `${resultPath}.reservation`;
    try {
      await writeFile(reservationPath, JSON.stringify(expected), "utf8");
      await testBody({ directory, resultPath, reservationPath, expected });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  test("requires the adapter-owned reservation and never creates one", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pi-tasked-subagents-result-"));
    const expected = { sessionId: "session-test", runId: "run-test", resultId: "0123456789abcdef0123456789abcdef" };
    const reservationPath = path.join(directory, "missing.reservation");
    try {
      await expect(verifyResultReservation(reservationPath, expected)).rejects.toThrow("reservation");
      await expect(readFile(reservationPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
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
