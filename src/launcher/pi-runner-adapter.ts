// ──────────────────────────────────────────────
// PiRunnerAdapter — task-graph launcher implementation
// ──────────────────────────────────────────────

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_WAIT_TIMEOUT_MS } from "../defaults.js";
import { isResultId, isSessionId, resolveStorageRoot, resultFilePath, resultReservationPath, runDirectoryPath, runFilePath, sessionStoragePaths } from "../state/storage-paths.js";
import type {
  LaunchTaskEntry,
  LaunchTaskGraphRequest,
  RunCounts,
  RunProgressSnapshot,
  RunStatus,
  DurableSubagentRunHandle,
  SubagentRunHandle,
  SubagentRuntime,
  TaskAssignmentRecord,
} from "../types.js";
import { getAgentProfile, listAvailableAgentProfiles } from "./agent-profiles.js";
import { ensureTaskGraphRequest, type LaunchResult, type RunnerRuntimeContext, type RunnerChildConfig, type RunnerConfig } from "./interface.js";
import { captureProcessIdentity, isProcessIdentityAlive, signalProcessIdentity } from "./process-identity.mjs";
import { publishTerminalResult, releaseResultReservation, reserveResultReservation } from "./result-files.mjs";

function now(): number {
  return Date.now();
}

function runnerPath(): string {
  return fileURLToPath(new URL("./direct-runner.mjs", import.meta.url));
}

async function readJsonFile<T>(filePath: string | undefined): Promise<T | undefined> {
  if (!filePath) return undefined;
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function tempRoot(): string {
  return path.join(os.tmpdir(), "pi-tasked-subagents");
}

function defaultAsyncRoot(): string {
  return path.join(tempRoot(), "async-runs");
}

function defaultResultsRoot(): string {
  return path.join(tempRoot(), "results");
}

const SAFE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeJoin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, ...segments);
  if (resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) return resolvedPath;
  throw new Error("Resolved path escapes configured root");
}

function childSessionDir(asyncDir: string, index: number): string {
  return path.join(asyncDir, `session-${index}`);
}

function childOutputFile(index: number): string {
  return `output-${index}.log`;
}

interface RunPaths {
  asyncDir: string;
  resultsDir: string;
  resultPath: string;
  resultReservationPath: string;
  statusPath: string;
  eventsPath: string;
}

interface ProcessIdentity {
  pid: number;
  startTime: string;
}

interface RunnerStatusFile {
  runId?: string;
  state?: "queued" | "running" | "complete" | "failed" | "paused" | "cancelled" | "skipped";
  pid?: number;
  pidStartTime?: string;
  steps?: Array<{
    id?: string;
    pid?: number;
    pidStartTime?: string;
    status?: string;
    agent?: string;
    currentTool?: string;
    lastActionAt?: number;
    lastActionSummary?: string;
    recentActivity?: string[];
  }>;
}

interface RunnerResultFile {
  runId?: string;
  state?: "complete" | "failed" | "paused" | "cancelled" | "skipped";
  success?: boolean;
  summary?: string;
  rawOutput?: string;
  results?: Array<{ stepId?: string | number; output?: string; rawOutput?: string; summary?: string; error?: string; success?: boolean }>;
}

function mapRunnerState(state: string | undefined): RunStatus {
  switch (state) {
    case "queued": return "queued";
    case "running": return "running";
    case "complete": return "completed";
    case "failed": return "failed";
    case "paused": return "paused";
    case "cancelled": return "cancelled";
    case "skipped": return "skipped";
    default: return "queued";
  }
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "paused" || status === "skipped";
}

const TERMINAL_RESULT_STATUS_GRACE_MS = 1_000;
const TERMINAL_RESULT_STATUS_POLL_INTERVAL_MS = 25;

function buildProgressSnapshot(runId: string, statusFile: RunnerStatusFile): RunProgressSnapshot {
  return {
    runId,
    status: mapRunnerState(statusFile.state),
    steps: (statusFile.steps ?? []).map((step) => ({
      id: step.id,
      status: step.status,
      agent: step.agent,
      currentTool: step.currentTool,
      lastActionAt: step.lastActionAt,
      lastActionSummary: step.lastActionSummary,
      recentActivity: step.recentActivity,
    })),
  };
}

function emptyCounts(): RunCounts {
  return {
    queued: 0,
    running: 0,
    blocked: 0,
    attention: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    paused: 0,
    skipped: 0,
  };
}

function toRunHandleBase(launch: LaunchResult): Omit<DurableSubagentRunHandle, "assignments"> {
  return {
    runId: launch.runId,
    asyncId: launch.asyncId,
    sessionId: launch.sessionId,
    asyncDir: launch.asyncDir,
    resultId: launch.resultId,
    resultPath: launch.resultPath,
    resultReservationPath: launch.resultReservationPath,
    sessionFile: launch.sessionFile,
    artifactPath: launch.artifactPath,
  };
}

function preservedStepStatus(status: string | undefined): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


export interface PiRunnerAdapterOptions {
  piBin?: string;
  /** Application-data root override for tests and embedders. */
  dataRoot?: string;
  /** @deprecated Test-only compatibility override for pre-v5 run directories. */
  asyncDirRootOverride?: string;
  /** @deprecated Test-only compatibility override for pre-v5 result directories. */
  resultsDirOverride?: string;
  /** Injectable only for deterministic tests; production uses cryptographic random bytes. */
  resultIdFactory?: () => string;
  /** Injectable operation boundary for deterministic pinned-storage race tests. */
  storageMutationHook?: (operation: "reserve-result" | "publish-terminal-result") => Promise<void> | void;
  /** Injectable only for deterministic unavailable-procfs tests. */
  procDirectoryPath?: (fd: number) => string;
}

export class PiRunnerAdapter implements SubagentRuntime<RunnerRuntimeContext> {
  private readonly piBin: string;
  private readonly dataRoot: string;
  private readonly asyncRoot: string;
  private readonly resultsRoot: string;
  private readonly resultIdFactory: () => string;
  private readonly storageMutationHook: PiRunnerAdapterOptions["storageMutationHook"];
  private readonly procDirectoryPath: PiRunnerAdapterOptions["procDirectoryPath"];
  /** Each launch is keyed by session and immutable identity, never by report-oriented runId. */
  private readonly trackedLaunches = new Map<string, { launch: LaunchResult; identity?: ProcessIdentity }>();

  constructor(options: PiRunnerAdapterOptions = {}) {
    this.piBin = options.piBin ?? "pi";
    // Legacy directory overrides are used only by explicitly marked legacy
    // handles. All new durable launches use the application-data root.
    this.dataRoot = resolveStorageRoot({ dataRoot: options.dataRoot });
    this.asyncRoot = options.asyncDirRootOverride ?? defaultAsyncRoot();
    this.resultsRoot = options.resultsDirOverride ?? defaultResultsRoot();
    this.resultIdFactory = options.resultIdFactory ?? (() => randomBytes(16).toString("hex"));
    this.storageMutationHook = options.storageMutationHook;
    this.procDirectoryPath = options.procDirectoryPath;
  }

  async launchTaskGraph(request: LaunchTaskGraphRequest, ctx: RunnerRuntimeContext): Promise<DurableSubagentRunHandle> {
    ensureTaskGraphRequest(request);
    const sessionId = typeof ctx?.sessionId === "string" ? ctx.sessionId : "";
    const requestCwd = typeof request.cwd === "string" && request.cwd.trim() ? request.cwd.trim() : undefined;
    const contextCwd = typeof ctx?.cwd === "string" && ctx.cwd.trim() ? ctx.cwd.trim() : undefined;
    const cwd = requestCwd ?? contextCwd;
    if (!cwd) throw new Error("Task graph cwd is required");
    const resultsDir = this.requireResultsDir(sessionId);
    const reservation = await this.reserveResultIdentity(sessionId, request.runId, resultsDir);
    let launched = false;
    try {
      const paths = this.requireRunPaths(request.runId, sessionId, reservation.resultId);
      const children = this.buildChildren(request.tasks, cwd, paths.asyncDir);
      const config: RunnerConfig = {
        runId: request.runId,
        sessionId,
        mode: "task_graph",
        maxConcurrency: request.maxConcurrency,
        piBin: this.piBin,
        storageRoot: this.dataRoot,
        asyncDir: paths.asyncDir,
        resultsDir: paths.resultsDir,
        resultId: reservation.resultId,
        resultPath: reservation.resultPath,
        resultReservationPath: reservation.resultReservationPath,
        statusPath: paths.statusPath,
        eventsPath: paths.eventsPath,
        children,
      };
      const launch = await this.buildAndLaunch(config);
      launched = true;
      return {
        ...toRunHandleBase(launch),
        assignments: request.tasks.map((task) => ({
          assignmentId: task.assignmentId.trim(),
          runId: launch.runId,
          resultPath: launch.resultPath,
        })),
      };
    } finally {
      if (!launched) {
        await releaseResultReservation(this.dataRoot, resultsDir, {
          sessionId,
          runId: request.runId,
          resultId: reservation.resultId,
        }, { procDirectoryPath: this.procDirectoryPath }).catch(() => undefined);
      }
    }
  }

  async stopRun(handle: SubagentRunHandle, ctx: RunnerRuntimeContext): Promise<boolean> {
    return this.terminate(handle, "paused", "Stopped by user; continuation available", ctx);
  }

  async cancelRun(handle: SubagentRunHandle, ctx: RunnerRuntimeContext): Promise<boolean> {
    return this.terminate(handle, "cancelled", "Cancelled by user", ctx);
  }

  async waitForRunSignal(
    handle: SubagentRunHandle | undefined,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      ctx?: unknown;
      onUpdate?: (snapshot: RunProgressSnapshot) => void | Promise<void>;
    },
  ): Promise<RunStatus> {
    if (!handle) return "completed";
    const { runId } = handle;
    const resolved = this.resolveRunHandle(handle);
    if (!resolved) return "failed";
    const { paths, launch } = resolved;

    const deadline = now() + (options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    let terminalResultStatus: RunStatus | undefined;
    let terminalResultSeenAt: number | undefined;
    while (now() < deadline) {
      if (options?.signal?.aborted) return "cancelled";
      const statusFile = await readJsonFile<RunnerStatusFile>(paths.statusPath);
      if (statusFile?.state) {
        await options?.onUpdate?.(buildProgressSnapshot(runId, statusFile));
      }
      const result = await readJsonFile<RunnerResultFile>(launch.resultPath ?? paths.resultPath);
      if (result?.state) {
        const status = mapRunnerState(result.state);
        if (isTerminalStatus(status)) {
          terminalResultStatus ??= status;
          terminalResultSeenAt ??= now();
          if (now() - terminalResultSeenAt >= TERMINAL_RESULT_STATUS_GRACE_MS) return terminalResultStatus;
        }
      }
      await sleep(terminalResultStatus ? TERMINAL_RESULT_STATUS_POLL_INTERVAL_MS : DEFAULT_POLL_INTERVAL_MS);
    }
    return terminalResultStatus ?? "attention";
  }

  async getRunResult(handle: SubagentRunHandle): Promise<string | undefined> {
    const { runId } = handle;
    const resolved = this.resolveRunHandle(handle);
    if (!resolved) return undefined;
    const result = await readJsonFile<RunnerResultFile>(resolved.launch.resultPath);
    if (!result) return undefined;
    if (typeof result.rawOutput === "string" && result.rawOutput.trim()) return result.rawOutput;
    if (Array.isArray(result.results) && result.results.length > 1) {
      return JSON.stringify({
        runId,
        results: result.results.map((child) => ({
          stepId: child.stepId,
          output: child.rawOutput ?? child.output ?? "",
          summary: child.summary,
          error: child.error,
          success: child.success,
        })),
      });
    }
    const first = result.results?.[0];
    return first?.rawOutput || first?.output || result.summary;
  }

  async isRunAlive(handle: SubagentRunHandle): Promise<boolean> {
    const resolved = this.resolveRunHandle(handle);
    if (!resolved) return false;
    const statusFile = await readJsonFile<RunnerStatusFile>(resolved.paths.statusPath);
    const identities = this.processIdentities(handle, statusFile);
    for (const identity of identities) if (await isProcessIdentityAlive(identity)) return true;
    return false;
  }

  getSnapshot(): { assignments: TaskAssignmentRecord[]; counts: RunCounts } {
    return { assignments: [], counts: emptyCounts() };
  }

  private requireResultsDir(sessionId: string): string {
    if (!isSessionId(sessionId)) throw new Error("Unsafe session ID");
    return sessionStoragePaths(this.dataRoot, sessionId).resultsDir;
  }

  /** Derive, never trust, every durable path from its validated identities. */
  private runPaths(runId: string, sessionId: string, resultId: string): RunPaths | undefined {
    if (!SAFE_RUN_ID_PATTERN.test(runId) || !isSessionId(sessionId) || !isResultId(resultId)) return undefined;
    const storage = sessionStoragePaths(this.dataRoot, sessionId);
    const asyncDir = runDirectoryPath(storage, resultId);
    const resultPath = resultFilePath(storage, resultId);
    return {
      asyncDir,
      resultsDir: storage.resultsDir,
      resultPath,
      resultReservationPath: resultReservationPath(storage, resultId),
      statusPath: runFilePath(storage, resultId, "status.json"),
      eventsPath: runFilePath(storage, resultId, "events.jsonl"),
    };
  }

  private legacyRunPaths(runId: string): RunPaths | undefined {
    if (!SAFE_RUN_ID_PATTERN.test(runId)) return undefined;
    const asyncDir = safeJoin(this.asyncRoot, runId);
    const resultPath = safeJoin(this.resultsRoot, `${runId}.json`);
    return {
      asyncDir,
      resultsDir: this.resultsRoot,
      resultPath,
      resultReservationPath: `${resultPath}.reservation`,
      statusPath: safeJoin(asyncDir, "status.json"),
      eventsPath: safeJoin(asyncDir, "events.jsonl"),
    };
  }

  private requireRunPaths(runId: string, sessionId: string, resultId: string): RunPaths {
    const paths = this.runPaths(runId, sessionId, resultId);
    if (!paths) throw new Error("Unsafe run ID");
    return paths;
  }

  private async reserveResultIdentity(sessionId: string, runId: string, resultsDir: string): Promise<{
    resultId: string;
    resultPath: string;
    resultReservationPath: string;
  }> {
    if (!sessionId) throw new Error("Unsafe session ID");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const resultId = this.resultIdFactory();
      if (!/^[a-f0-9]{32}$/u.test(resultId)) throw new Error("Result ID factory returned an invalid 128-bit identity");
      try {
        const reservation = await reserveResultReservation(this.dataRoot, resultsDir, { sessionId, runId, resultId }, {
          beforeMutation: this.storageMutationHook,
          procDirectoryPath: this.procDirectoryPath,
        });
        return { resultId, ...reservation };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
    }
    throw new Error("Could not reserve a unique immutable result identity");
  }

  private buildChildren(entries: LaunchTaskEntry[], baseCwd: string, asyncDir: string): RunnerChildConfig[] {
    const profiles = listAvailableAgentProfiles();
    const profilesByName = new Map(profiles.map((profile) => [profile.name, profile]));
    const delegateProfile = profilesByName.get("delegate") ?? getAgentProfile("delegate");
    return entries.map((entry, index) => {
      const profile = profilesByName.get(entry.agent) ?? { ...delegateProfile, name: entry.agent };
      const cwd = typeof entry.cwd === "string" && entry.cwd.trim().length > 0 ? entry.cwd.trim() : baseCwd;
      return {
        id: entry.assignmentId.trim(),
        dependsOn: entry.dependsOn?.map((dependencyId) => dependencyId.trim()),
        agent: entry.agent,
        taskSummary: entry.taskSummary,
        prompt: entry.prompt,
        cwd,
        sessionDir: childSessionDir(asyncDir, index),
        outputFile: childOutputFile(index),
        retries: entry.retries,
        outputMode: entry.outputMode,
        outputSchema: entry.outputSchema,
        when: entry.when,
        resolvedModel: profile.model,
        resolvedThinking: profile.thinking,
        systemPrompt: profile.systemPrompt,
        systemPromptMode: profile.systemPromptMode ?? "append",
        tools: profile.tools,
        inheritProjectContext: profile.inheritProjectContext,
        inheritSkills: profile.inheritSkills,
      };
    });
  }

  private async buildAndLaunch(config: RunnerConfig): Promise<LaunchResult> {
    await fsp.mkdir(config.asyncDir, { recursive: true });
    const configPath = safeJoin(config.asyncDir, "config.json");
    await writeJsonFile(configPath, config);
    const launch: LaunchResult = {
      runId: config.runId,
      asyncId: config.runId,
      asyncDir: config.asyncDir,
      sessionId: config.sessionId,
      resultId: config.resultId,
      resultPath: config.resultPath,
      resultReservationPath: config.resultReservationPath,
    };
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [runnerPath(), configPath], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("spawn", () => {
        const key = this.launchKey(config.sessionId, config.resultId);
        let exited = false;
        child.once("exit", () => {
          exited = true;
          this.trackedLaunches.delete(key);
        });
        void (async () => {
          const identity = child.pid === undefined ? undefined : await captureProcessIdentity(child.pid);
          if (!exited) this.trackedLaunches.set(key, { launch, identity });
          child.unref();
          resolve();
        })().catch(reject);
      });
    });
    return launch;
  }

  private launchKey(sessionId: string, resultId: string): string {
    return `${sessionId}:${resultId}`;
  }

  /** PID values are useful only with the kernel-issued process start time. */
  private processIdentities(
    handle: SubagentRunHandle,
    statusFile: RunnerStatusFile | undefined,
    tracked = handle.legacy ? undefined : this.trackedLaunches.get(this.launchKey(handle.sessionId, handle.resultId)),
  ): ProcessIdentity[] {
    const identities = new Map<string, ProcessIdentity>();
    const add = (pid: number | undefined, startTime: string | undefined): void => {
      if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0 || typeof startTime !== "string" || !/^\d+$/u.test(startTime)) return;
      identities.set(`${pid}:${startTime}`, { pid, startTime });
    };
    if (!handle.legacy && tracked?.identity) add(tracked.identity.pid, tracked.identity.startTime);
    add(statusFile?.pid, statusFile?.pidStartTime);
    for (const step of statusFile?.steps ?? []) add(step.pid, step.pidStartTime);
    return [...identities.values()];
  }

  private resolveRunHandle(handle: SubagentRunHandle): { paths: RunPaths; launch: { resultPath: string } } | undefined {
    if (!SAFE_RUN_ID_PATTERN.test(handle.runId)) return undefined;
    if (!handle.legacy) {
      const paths = this.runPaths(handle.runId, handle.sessionId, handle.resultId);
      // Persisted paths are evidence only: a mismatch fails before any file I/O
      // or PID collection, rather than being used as an alternate location.
      if (!paths || handle.asyncDir !== paths.asyncDir || handle.resultPath !== paths.resultPath ||
        handle.resultReservationPath !== paths.resultReservationPath) return undefined;
      return { paths, launch: { resultPath: paths.resultPath } };
    }
    const fallback = !handle.asyncDir || !handle.resultPath ? this.legacyRunPaths(handle.runId) : undefined;
    const asyncDir = handle.asyncDir ?? fallback?.asyncDir;
    const resultPath = handle.resultPath ?? fallback?.resultPath;
    if (!asyncDir || !resultPath) return undefined;
    const paths: RunPaths = {
      asyncDir,
      resultsDir: path.dirname(resultPath),
      resultPath,
      resultReservationPath: `${resultPath}.reservation`,
      statusPath: safeJoin(asyncDir, "status.json"),
      eventsPath: safeJoin(asyncDir, "events.jsonl"),
    };
    return { paths, launch: { resultPath } };
  }

  private async terminate(
    handle: SubagentRunHandle,
    state: "paused" | "cancelled",
    summary: string,
    ctx: RunnerRuntimeContext,
  ): Promise<boolean> {
    const { runId } = handle;
    const sessionId = typeof ctx?.sessionId === "string" ? ctx.sessionId : "";
    if (!handle.legacy && sessionId !== handle.sessionId) return false;
    const resolved = this.resolveRunHandle(handle);
    if (!resolved) return false;
    const { paths, launch } = resolved;
    const tracked = handle.legacy ? undefined : this.trackedLaunches.get(this.launchKey(handle.sessionId, handle.resultId));
    const existingStatus = await readJsonFile<RunnerStatusFile>(paths.statusPath);
    const resultPath = launch.resultPath ?? paths.resultPath;

    const identities = this.processIdentities(handle, existingStatus, tracked);

    const timestamp = now();
    const terminalStatus = {
      ...(existingStatus ?? {}),
      runId,
      state,
      endedAt: timestamp,
      lastUpdate: timestamp,
      steps: existingStatus?.steps?.map((step) => ({
        ...step,
        status: preservedStepStatus(step.status) ? step.status : state,
      })),
    };
    const existingResult = await readJsonFile<RunnerResultFile>(resultPath);
    const terminalResult = {
      ...(existingResult ?? {}),
      runId,
      state,
      success: false,
      summary,
      timestamp,
    };

    let allSignaled = true;
    for (const identity of identities) {
      // A missing or stale identity is intentionally treated as no longer ours.
      if (await isProcessIdentityAlive(identity) && !await signalProcessIdentity(identity)) allSignaled = false;
    }

    await writeJsonFile(paths.statusPath, terminalStatus);
    if (handle.legacy) {
      await writeJsonFile(resultPath, terminalResult);
      return allSignaled;
    }
    try {
      await publishTerminalResult(resultPath, handle.resultReservationPath, {
        sessionId,
        runId,
        resultId: handle.resultId,
      }, terminalResult, {
        root: this.dataRoot,
        beforeMutation: this.storageMutationHook,
        procDirectoryPath: this.procDirectoryPath,
      });
    } catch {
      return false;
    }
    return allSignaled;
  }
}
