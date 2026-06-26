// ──────────────────────────────────────────────
// PiRunnerAdapter — task-graph launcher implementation
// ──────────────────────────────────────────────

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_WAIT_TIMEOUT_MS } from "../defaults.js";
import type {
  LaunchTaskEntry,
  LaunchTaskGraphRequest,
  RunCounts,
  RunProgressSnapshot,
  RunStatus,
  SubagentRunHandle,
  SubagentRuntime,
  TaskAssignmentRecord,
} from "../types.js";
import { getAgentProfile, listAvailableAgentProfiles } from "./agent-profiles.js";
import { ensureTaskGraphRequest, type LaunchResult, type RunnerRuntimeContext, type RunnerChildConfig, type RunnerConfig } from "./interface.js";

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
  resultPath: string;
  statusPath: string;
  eventsPath: string;
}

interface RunnerStatusFile {
  runId?: string;
  state?: "queued" | "running" | "complete" | "failed" | "paused" | "cancelled" | "skipped";
  pid?: number;
  steps?: Array<{
    id?: string;
    pid?: number;
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

function toRunHandleBase(launch: LaunchResult): Omit<SubagentRunHandle, "assignments"> {
  return {
    runId: launch.runId,
    asyncId: launch.asyncId,
    asyncDir: launch.asyncDir,
    resultPath: launch.resultPath,
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
  asyncDirRootOverride?: string;
  resultsDirOverride?: string;
}

export class PiRunnerAdapter implements SubagentRuntime<RunnerRuntimeContext> {
  private readonly piBin: string;
  private readonly asyncRoot: string;
  private readonly resultsRoot: string;
  private readonly trackedRuns = new Map<string, { launch: LaunchResult; pid?: number }>();

  constructor(options: PiRunnerAdapterOptions = {}) {
    this.piBin = options.piBin ?? "pi";
    this.asyncRoot = options.asyncDirRootOverride ?? defaultAsyncRoot();
    this.resultsRoot = options.resultsDirOverride ?? defaultResultsRoot();
  }

  async launchTaskGraph(request: LaunchTaskGraphRequest, ctx: RunnerRuntimeContext): Promise<SubagentRunHandle> {
    ensureTaskGraphRequest(request);
    const paths = this.requireRunPaths(request.runId);
    const runtimeCtx = ctx && typeof ctx === "object" ? ctx as Partial<RunnerRuntimeContext> : undefined;
    const requestCwd = typeof request.cwd === "string" && request.cwd.trim() ? request.cwd.trim() : undefined;
    const contextCwd = typeof runtimeCtx?.cwd === "string" && runtimeCtx.cwd.trim() ? runtimeCtx.cwd.trim() : undefined;
    const cwd = requestCwd ?? contextCwd;
    if (!cwd) throw new Error("Task graph cwd is required");
    const children = this.buildChildren(request.tasks, cwd, paths.asyncDir);
    const config: RunnerConfig = {
      runId: request.runId,
      mode: "task_graph",
      maxConcurrency: request.maxConcurrency,
      piBin: this.piBin,
      asyncDir: paths.asyncDir,
      resultsDir: this.resultsRoot,
      resultPath: paths.resultPath,
      statusPath: paths.statusPath,
      eventsPath: paths.eventsPath,
      children,
    };
    const launch = await this.buildAndLaunch(config);
    return {
      ...toRunHandleBase(launch),
      assignments: request.tasks.map((task) => ({
        assignmentId: task.assignmentId,
        runId: launch.runId,
        resultPath: launch.resultPath,
      })),
    };
  }

  async stopRun(handle: SubagentRunHandle, _ctx: unknown): Promise<boolean> {
    return this.terminate(handle, "paused", "Stopped by user; continuation available");
  }

  async cancelRun(handle: SubagentRunHandle, _ctx: unknown): Promise<boolean> {
    return this.terminate(handle, "cancelled", "Cancelled by user");
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
        const status = mapRunnerState(statusFile.state);
        if (isTerminalStatus(status)) return status;
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

  getSnapshot(): { assignments: TaskAssignmentRecord[]; counts: RunCounts } {
    return { assignments: [], counts: emptyCounts() };
  }

  private runPaths(runId: string): RunPaths | undefined {
    if (!SAFE_RUN_ID_PATTERN.test(runId)) return undefined;
    const asyncDir = safeJoin(this.asyncRoot, runId);
    return {
      asyncDir,
      resultPath: safeJoin(this.resultsRoot, `${runId}.json`),
      statusPath: safeJoin(asyncDir, "status.json"),
      eventsPath: safeJoin(asyncDir, "events.jsonl"),
    };
  }

  private requireRunPaths(runId: string): RunPaths {
    const paths = this.runPaths(runId);
    if (!paths) throw new Error("Unsafe run ID");
    return paths;
  }

  private buildChildren(entries: LaunchTaskEntry[], baseCwd: string, asyncDir: string): RunnerChildConfig[] {
    const profiles = listAvailableAgentProfiles();
    const profilesByName = new Map(profiles.map((profile) => [profile.name, profile]));
    const delegateProfile = profilesByName.get("delegate") ?? getAgentProfile("delegate");
    return entries.map((entry, index) => {
      const profile = profilesByName.get(entry.agent) ?? { ...delegateProfile, name: entry.agent };
      return {
        id: entry.assignmentId,
        dependsOn: entry.dependsOn,
        agent: entry.agent,
        taskSummary: entry.taskSummary,
        prompt: entry.prompt,
        cwd: entry.cwd ?? baseCwd,
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
    await fsp.mkdir(this.resultsRoot, { recursive: true });
    const configPath = safeJoin(config.asyncDir, "config.json");
    await writeJsonFile(configPath, config);
    const launch: LaunchResult = {
      runId: config.runId,
      asyncId: config.runId,
      asyncDir: config.asyncDir,
      resultPath: config.resultPath,
    };
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [runnerPath(), configPath], {
        cwd: process.cwd(),
        detached: true,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("spawn", () => {
        this.trackedRuns.set(config.runId, { launch, pid: child.pid ?? undefined });
        child.unref();
        resolve();
      });
    });
    return launch;
  }

  private resolveRunHandle(handle: SubagentRunHandle): { paths: RunPaths; launch: LaunchResult } | undefined {
    const fallback = this.runPaths(handle.runId);
    if (!fallback) return undefined;
    const asyncDir = handle.asyncDir ?? fallback.asyncDir;
    const paths = {
      asyncDir,
      resultPath: handle.resultPath ?? fallback.resultPath,
      statusPath: safeJoin(asyncDir, "status.json"),
      eventsPath: safeJoin(asyncDir, "events.jsonl"),
    };
    const trackedLaunch = this.trackedRuns.get(handle.runId)?.launch;
    const launch = {
      ...trackedLaunch,
      runId: handle.runId,
      asyncId: handle.asyncId,
      asyncDir: paths.asyncDir,
      resultPath: paths.resultPath,
      sessionFile: handle.sessionFile ?? trackedLaunch?.sessionFile,
      artifactPath: handle.artifactPath ?? trackedLaunch?.artifactPath,
    };
    return { paths, launch };
  }

  private async terminate(handle: SubagentRunHandle, state: "paused" | "cancelled", summary: string): Promise<boolean> {
    const { runId } = handle;
    const resolved = this.resolveRunHandle(handle);
    if (!resolved) return false;
    const { paths, launch } = resolved;
    const tracked = this.trackedRuns.get(runId);
    const existingStatus = await readJsonFile<RunnerStatusFile>(paths.statusPath);
    const resultPath = launch.resultPath ?? paths.resultPath;

    const pids = new Set<number>();
    if (tracked?.pid) pids.add(tracked.pid);
    if (existingStatus?.pid) pids.add(existingStatus.pid);
    for (const step of existingStatus?.steps ?? []) if (step.pid) pids.add(step.pid);

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
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        const code = typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
        if (code !== "ESRCH") allSignaled = false;
      }
    }

    await writeJsonFile(paths.statusPath, terminalStatus);
    await writeJsonFile(resultPath, terminalResult);
    return allSignaled;
  }
}
