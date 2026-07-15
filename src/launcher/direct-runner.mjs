#!/usr/bin/env node

// ──────────────────────────────────────────────
// direct-runner.mjs — task graph child-process runner
//
// Reads a RunnerConfig JSON file, spawns `pi` for each explicit task
// assignment, writes status.json and result.json so the adapter can poll for
// completion. The runner accepts only `mode: "task_graph"`; public orchestration
// is TaskRun -> Group -> Task -> Assignment -> Evidence.
// ──────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { publishTerminalResult } from "./result-files.mjs";

// ── Helpers ────────────────────────────────────

function now() {
  return Date.now();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

async function appendLine(filePath, line) {
  await ensureDir(path.dirname(filePath));
  await fs.appendFile(filePath, `${line}\n`, "utf8");
}

function summarizeOutput(text, maxLength = 400) {
  const singleLine = String(text || "").replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return singleLine.length <= maxLength
    ? singleLine
    : `${singleLine.slice(0, maxLength - 1).trimEnd()}…`;
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function extractAssistantText(message) {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part && part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function getPathValue(source, pathExpression) {
  if (!pathExpression) return source;
  const segments = String(pathExpression).split(".").filter(Boolean);
  let current = source;
  for (const segment of segments) {
    if (!current || typeof current !== "object" || !(segment in current)) return undefined;
    current = current[segment];
  }
  return current;
}

function getStructuredValue(structuredOutput, pathExpression) {
  if (!structuredOutput || typeof structuredOutput !== "object") return undefined;
  return getPathValue(structuredOutput, pathExpression);
}

function stringifyTemplateValue(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function isTruthyTaskGraphValue(value) {
  if (value === undefined || value === null || value === false) return false;
  if (typeof value === "string") return value.trim().length > 0 && value.trim().toLowerCase() !== "false";
  if (typeof value === "number") return value !== 0 && Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(value);
}

function childAgentName(child) {
  return child.agent ?? child.profile?.name ?? "delegate";
}

// ── Task graph template/reference support ─────

function resolveTaskGraphReference(stepId, fieldPath, results) {
  const stepResult = results?.[stepId];
  if (!stepResult) throw new Error(`Unknown task graph step reference: ${stepId}`);

  if (fieldPath === "summary") return stepResult.summary ?? summarizeOutput(stepResult.output) ?? "";
  if (fieldPath === "output") return stepResult.output ?? "";
  if (fieldPath === "rawOutput") return stepResult.rawOutput ?? stepResult.output ?? "";
  if (fieldPath === "error") return stepResult.error ?? "";
  if (fieldPath === "success") return stepResult.success ?? false;
  if (fieldPath === "json") {
    if (!stepResult.structuredOutput) throw new Error(`Task graph step ${stepId} has no structured output.`);
    return stepResult.structuredOutput;
  }

  const normalizedPath = fieldPath.startsWith("structured.") ? fieldPath.slice("structured.".length) : fieldPath;
  const structuredValue = getStructuredValue(stepResult.structuredOutput, normalizedPath);
  if (structuredValue === undefined) throw new Error(`Task graph step ${stepId} is missing structured field ${normalizedPath}.`);
  return structuredValue;
}

export function renderTaskGraphTemplate(template, results) {
  return String(template).replace(/\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\s*\}\}/g, (_match, stepId, fieldPath) => {
    return stringifyTemplateValue(resolveTaskGraphReference(stepId, fieldPath, results));
  });
}

export function evaluateTaskGraphCondition(expression, results) {
  if (expression === undefined || expression === null || String(expression).trim() === "") return true;
  const trimmed = String(expression).trim();
  const referenceMatch = trimmed.match(/^\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\s*\}\}$/u);
  if (referenceMatch) return isTruthyTaskGraphValue(resolveTaskGraphReference(referenceMatch[1], referenceMatch[2], results));
  return isTruthyTaskGraphValue(renderTaskGraphTemplate(trimmed, results));
}

function extractFencedJsonCandidate(text) {
  const match = text.match(/```(?:json|JSON)?\s*\n([\s\S]*?)\n```/u);
  return match?.[1]?.trim();
}

function extractBalancedJsonObjectCandidate(text) {
  const start = text.indexOf("{");
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return text.slice(start, index + 1).trim();
  }
  return undefined;
}

function parseJsonObjectCandidate(candidate) {
  if (!candidate) return undefined;
  const parsed = JSON.parse(candidate);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object response for structured task output.");
  }
  return parsed;
}

export function parseStructuredStepOutput(output, outputMode) {
  if (outputMode !== "json") return undefined;
  const trimmed = String(output ?? "").trim();
  if (!trimmed) throw new Error("Expected a JSON object response, but the task graph step returned an empty output.");

  const candidates = [trimmed, extractFencedJsonCandidate(trimmed), extractBalancedJsonObjectCandidate(trimmed)];
  let lastError;
  for (const candidate of candidates) {
    try {
      const parsed = parseJsonObjectCandidate(candidate);
      if (parsed) return parsed;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Expected a JSON object response for structured task output.");
}

export async function runTaskGraphStepWithRetries({ maxAttempts, executeAttempt, isSuccessful = (result) => result?.success !== false, onAttemptFailure }) {
  const attempts = [];
  let lastResult;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await executeAttempt(attempt);
      const success = isSuccessful(result);
      attempts.push({ attempt, success, result, error: success ? undefined : toErrorMessage(result?.error ?? "Task graph step failed") });
      lastResult = result;
      if (success) return { attemptCount: attempt, attempts, finalResult: result };
      if (attempt < maxAttempts) await onAttemptFailure?.({ attempt, retriesRemaining: maxAttempts - attempt, result });
    } catch (error) {
      lastError = error;
      attempts.push({ attempt, success: false, error: toErrorMessage(error) });
      if (error?.nonRetryable) break;
      if (attempt < maxAttempts) await onAttemptFailure?.({ attempt, retriesRemaining: maxAttempts - attempt, error });
    }
  }

  const attemptCount = attempts.length;
  if (lastResult !== undefined) return { attemptCount, attempts, finalResult: lastResult };
  const terminalError = lastError instanceof Error ? lastError : new Error(toErrorMessage(lastError ?? "Task graph step failed"));
  terminalError.attempts = attempts;
  terminalError.attemptCount = attemptCount;
  throw terminalError;
}

// ── Status management ─────────────────────────

function createInitialStatus(config) {
  const startedAt = now();
  return {
    runId: config.runId,
    mode: config.mode,
    pid: process.pid,
    state: "queued",
    startedAt,
    lastUpdate: startedAt,
    lastActionAt: startedAt,
    lastActionSummary: "queued",
    steps: config.children.map((child, index) => ({
      index,
      id: child.id,
      agent: child.agent,
      status: "pending",
      taskSummary: child.taskSummary,
      dependsOn: child.dependsOn,
      when: child.when,
      retries: child.retries ?? 0,
      maxAttempts: (child.retries ?? 0) + 1,
      attempt: 0,
      outputMode: child.outputMode ?? "text",
      outputSchema: child.outputSchema,
      sessionDir: child.sessionDir,
      outputFile: child.outputFile,
    })),
  };
}

function deriveRootState(statusOrSteps) {
  const steps = Array.isArray(statusOrSteps) ? statusOrSteps : statusOrSteps.steps ?? [];
  if (steps.some((s) => s.status === "running" || s.status === "pending")) return "running";
  if (steps.some((s) => s.status === "failed")) return "failed";
  if (steps.some((s) => s.status === "paused")) return "paused";
  if (steps.some((s) => s.status === "cancelled")) return "cancelled";
  return "complete";
}

function markStepAction(status, step, summary) {
  const timestamp = now();
  step.lastActionAt = timestamp;
  step.lastActionSummary = summary;
  step.recentActivity = [...(step.recentActivity ?? []), summary].slice(-3);
  status.lastActionAt = timestamp;
  status.lastActionSummary = summary;
}

async function updateStatus(statusPath, status) {
  status.state = deriveRootState(status);
  status.lastUpdate = now();
  await writeJson(statusPath, status);
}

export function getDependencyBlockedSkip(child, failedIds, skippedIds) {
  const dependencyIds = child.dependsOn ?? [];
  if (dependencyIds.some((dependencyId) => failedIds.has(dependencyId))) {
    return { reason: "Skipped because a dependency did not complete.", success: false };
  }
  if (dependencyIds.some((dependencyId) => skippedIds.has(dependencyId))) {
    return { reason: "Skipped because a dependency was skipped.", success: true };
  }
  return undefined;
}

export function assertUniqueTaskGraphStepIds(children) {
  const seen = new Set();
  for (const child of children) {
    const id = typeof child.id === "string" ? child.id.trim() : "";
    if (!id) throw new Error("Task graph step ids must be non-empty strings.");
    if (seen.has(id)) throw new Error(`Duplicate task graph step id: ${id}`);
    seen.add(id);
  }
}

export function getReadyTaskGraphStepIds(steps, maxConcurrency) {
  const runningCount = steps.filter((step) => step.status === "running").length;
  const availableSlots = Math.max(0, maxConcurrency - runningCount);
  if (availableSlots === 0) return [];

  const completedIds = new Set(
    steps
      .filter((step) => step.status === "completed" && typeof step.id === "string" && step.id.length > 0)
      .map((step) => step.id),
  );

  return steps
    .filter((step) => step.status === "pending")
    .filter((step) => (step.dependsOn ?? []).every((dependencyId) => completedIds.has(dependencyId)))
    .slice(0, availableSlots)
    .map((step) => step.id)
    .filter((stepId) => typeof stepId === "string" && stepId.length > 0);
}

function createSerialLineProcessor(processLine, onError) {
  let queue = Promise.resolve();
  const enqueue = (lines) => {
    if (!Array.isArray(lines) || lines.length === 0) return;
    queue = queue.then(async () => {
      for (const line of lines) await processLine(line);
    }).catch((error) => onError?.(error));
  };
  return {
    enqueue,
    async flush(finalLine) {
      if (typeof finalLine === "string" && finalLine.trim()) enqueue([finalLine]);
      await queue;
    },
  };
}

function shouldPersistEvent(event) {
  return event?.type === "tool_execution_start"
    || event?.type === "tool_execution_end"
    || event?.type === "message_end"
    || event?.type === "turn_end";
}

// ── Child spawn ───────────────────────────────

function appendPiChildArgs(args, child) {
  if (child.resolvedModel) args.push("--model", child.resolvedModel);
  if (child.resolvedThinking) args.push("--thinking", child.resolvedThinking);
  if (Array.isArray(child.tools) && child.tools.length > 0) args.push("--tools", child.tools.join(","));
  if (child.inheritProjectContext === false) args.push("--no-context-files");
  if (child.inheritSkills === false) args.push("--no-skills");
  if (child.systemPrompt) {
    args.push(child.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", child.systemPrompt);
  }
}

export function buildPiArgs(child, promptOverride) {
  const args = ["--mode", "json", "--session-dir", child.sessionDir];
  appendPiChildArgs(args, child);
  const basePrompt = promptOverride ?? child.prompt;
  const structuredOutputInstruction = child.outputMode === "json"
    ? `\n\nReturn ONLY a valid JSON object in your final answer.${child.outputSchema ? ` Match this schema guidance exactly:\n${child.outputSchema}` : ""}`
    : "";
  args.push(`${basePrompt}${structuredOutputInstruction}`);
  return args;
}

export function prepareStepForStart(status, step) {
  step.status = "running";
  step.startedAt = now();
  step.currentTool = undefined;
  step.recentActivity = [];
  step.toolCount = 0;
  markStepAction(status, step, "child started");
}

async function runChild(config, statusPath, status, child, index, promptOverride, attemptNumber = 1) {
  const step = status.steps[index];
  prepareStepForStart(status, step);
  step.attempt = attemptNumber;
  step.error = undefined;
  step.summary = undefined;
  step.structuredOutput = undefined;
  await updateStatus(statusPath, status);

  const args = buildPiArgs(child, promptOverride);
  const childProcess = spawn(config.piBin, args, {
    cwd: child.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });

  step.pid = childProcess.pid;
  await updateStatus(statusPath, status);

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let finalOutput = "";
  let toolCount = 0;

  const processLine = async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      await appendLine(config.eventsPath, JSON.stringify({ runId: config.runId, index, raw: trimmed }));
      return;
    }

    if (shouldPersistEvent(event)) {
      await appendLine(config.eventsPath, JSON.stringify({ runId: config.runId, index, raw: trimmed }));
    }

    if (event.type === "tool_execution_start") {
      step.currentTool = event.toolName;
      markStepAction(status, step, `tool start: ${event.toolName ?? "unknown"}`);
      await updateStatus(statusPath, status);
      return;
    }

    if (event.type === "tool_execution_end") {
      const toolName = step.currentTool ?? event.toolName ?? "unknown";
      step.currentTool = undefined;
      toolCount += 1;
      step.toolCount = toolCount;
      markStepAction(status, step, `tool end: ${toolName}`);
      await updateStatus(statusPath, status);
      return;
    }

    if (event.type === "message_end" && event.message) {
      const text = extractAssistantText(event.message);
      if (text) finalOutput = text;
      markStepAction(status, step, "assistant message");
      await updateStatus(statusPath, status);
      return;
    }

    if (event.type === "turn_end") {
      markStepAction(status, step, "turn end");
      await updateStatus(statusPath, status);
    }
  };

  const stdoutProcessor = createSerialLineProcessor(processLine, (error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error("[pi-tasked-subagents] failed to process child stdout line:", message);
  });

  childProcess.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    stdoutProcessor.enqueue(lines);
  });

  childProcess.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
  });

  const exitCode = await new Promise((resolve, reject) => {
    childProcess.once("error", reject);
    childProcess.once("close", (code) => resolve(code ?? 1));
  });

  const trailingStdout = stdoutBuffer;
  stdoutBuffer = "";
  await stdoutProcessor.flush(trailingStdout);

  step.endedAt = now();
  step.exitCode = exitCode;
  step.currentTool = undefined;

  let structuredOutput;
  let summary;
  if (exitCode === 0) {
    try {
      structuredOutput = parseStructuredStepOutput(finalOutput, child.outputMode);
      summary = structuredOutput?.summary && typeof structuredOutput.summary === "string" ? structuredOutput.summary : summarizeOutput(finalOutput);
      step.status = "completed";
      step.error = undefined;
      step.summary = summary;
      step.structuredOutput = structuredOutput;
    } catch (error) {
      step.status = "failed";
      step.error = toErrorMessage(error);
      step.summary = undefined;
      step.structuredOutput = undefined;
    }
  } else {
    step.status = "failed";
    step.error = summarizeOutput(stderrBuffer) || `pi exited with code ${exitCode}`;
    step.summary = undefined;
    step.structuredOutput = undefined;
  }

  if (finalOutput) await fs.writeFile(path.join(config.asyncDir, child.outputFile), finalOutput, "utf8");
  await updateStatus(statusPath, status);

  return {
    stepId: child.id || index,
    taskSummary: child.taskSummary,
    dependsOn: child.dependsOn,
    agent: childAgentName(child),
    output: finalOutput,
    rawOutput: finalOutput,
    summary,
    structuredOutput,
    error: step.status === "completed" ? undefined : step.error,
    success: step.status === "completed",
    status: step.status,
    attempt: attemptNumber,
    maxAttempts: (child.retries ?? 0) + 1,
    lastActionAt: step.lastActionAt,
    lastActionSummary: step.lastActionSummary,
    toolCount: step.toolCount,
    artifactPaths: { outputPath: path.join(config.asyncDir, child.outputFile) },
  };
}

// ── Result writing ────────────────────────────

function buildResultSummary(results, maxChildLength = 200) {
  const lines = results
    .map((r) => {
      const text = summarizeOutput(r.summary || r.output || r.error || "(no output)", maxChildLength);
      return text ? `${r.stepId ?? r.agent}: ${text}` : undefined;
    })
    .filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function isPreservedStepStatus(status) {
  return status === "completed" || status === "failed" || status === "skipped";
}

export function renderTerminationSignal(existingStatus = {}, existingResult = {}, timestamp = now()) {
  const state = existingStatus.state === "cancelled" || existingResult.state === "cancelled" ? "cancelled" : "paused";
  const summary = existingResult.state === state && existingResult.summary
    ? existingResult.summary
    : state === "cancelled" ? "Cancelled by user" : "Stopped by SIGTERM";

  return {
    status: {
      ...existingStatus,
      state,
      endedAt: timestamp,
      lastUpdate: timestamp,
      steps: (existingStatus.steps ?? []).map((step) => ({
        ...step,
        status: isPreservedStepStatus(step.status) ? step.status : state,
      })),
    },
    result: {
      ...existingResult,
      state,
      success: false,
      summary,
      timestamp,
    },
  };
}

function skippedChildResult(child, reason, success = true) {
  return {
    stepId: child.id,
    taskSummary: child.taskSummary,
    dependsOn: child.dependsOn,
    agent: childAgentName(child),
    output: "",
    rawOutput: "",
    summary: reason,
    error: success ? undefined : reason,
    success,
    status: "skipped",
    skipped: true,
    skipReason: reason,
    attempt: 0,
    maxAttempts: (child.retries ?? 0) + 1,
    attempts: [],
  };
}

function failedChildResult(config, child, error, attempt = 1, attempts = []) {
  return {
    stepId: child.id,
    taskSummary: child.taskSummary,
    dependsOn: child.dependsOn,
    agent: childAgentName(child),
    output: "",
    rawOutput: "",
    error,
    success: false,
    status: "failed",
    attempt,
    maxAttempts: (child.retries ?? 0) + 1,
    attempts,
    artifactPaths: { outputPath: path.join(config.asyncDir, child.outputFile) },
  };
}

function buildTaskGraphResultsMap(results) {
  return Object.fromEntries(
    results
      .filter((result) => typeof result?.stepId === "string" && result.stepId.length > 0)
      .map((result) => [result.stepId, {
        summary: result.summary ?? summarizeOutput(result.output || result.error || "") ?? "",
        output: result.output ?? result.error ?? "",
        rawOutput: result.rawOutput ?? result.output ?? result.error ?? "",
        error: result.error,
        success: result.success,
        structuredOutput: result.structuredOutput,
      }]),
  );
}

function markTaskGraphStepsSkipped(status, stepIds, reason) {
  let changed = false;
  const wanted = new Set(stepIds);
  for (const step of status.steps ?? []) {
    if (!wanted.has(step.id) || (step.status !== "pending" && step.status !== "running")) continue;
    step.status = "skipped";
    step.error = undefined;
    step.skipReason = reason;
    step.summary = reason;
    step.structuredOutput = undefined;
    step.endedAt = now();
    changed = true;
  }
  return changed;
}

async function writeResult(config, status, results) {
  const timestamp = now();
  const success = results.every((r) => r.success);
  const summary = buildResultSummary(results);
  const rawOutput = results.length === 1 ? results[0]?.rawOutput || results[0]?.output : undefined;

  await publishTerminalResult(config.resultPath, config.resultReservationPath, {
    sessionId: config.sessionId,
    runId: config.runId,
    resultId: config.resultId,
  }, {
    state: success ? "complete" : "failed",
    success,
    summary,
    rawOutput,
    timestamp,
    results,
  });

  status.state = success ? "complete" : "failed";
  status.endedAt = timestamp;
  status.lastUpdate = timestamp;
  await writeJson(config.statusPath, status);
}

async function runTaskGraph(config, status) {
  assertUniqueTaskGraphStepIds(config.children);
  const results = [];
  const active = new Map();
  const maxConcurrency = Math.max(1, config.maxConcurrency ?? config.children.length);

  while (results.length < config.children.length) {
    const failedIds = new Set(results.filter((result) => !result.success && !result.skipped).map((result) => result.stepId));
    const skippedIds = new Set(results.filter((result) => result.skipped).map((result) => result.stepId));
    const unsatisfiedIds = new Set([...failedIds, ...skippedIds]);

    const dependencyBlockedChildren = config.children
      .map((child) => ({ child, skip: results.some((result) => result.stepId === child.id) ? undefined : getDependencyBlockedSkip(child, failedIds, skippedIds) }))
      .filter((entry) => entry.skip);

    if (dependencyBlockedChildren.length > 0) {
      for (const { child, skip } of dependencyBlockedChildren) {
        const changed = markTaskGraphStepsSkipped(status, [child.id], skip.reason);
        if (changed) await updateStatus(config.statusPath, status);
        if (results.some((result) => result.stepId === child.id)) continue;
        results.push(skippedChildResult(child, skip.reason, skip.success));
      }
      continue;
    }

    const readyStepIds = getReadyTaskGraphStepIds(
      (status.steps ?? []).filter((step) => !(step.dependsOn ?? []).some((dependencyId) => unsatisfiedIds.has(dependencyId))),
      maxConcurrency,
    );

    let progressedWithoutActive = false;
    for (const stepId of readyStepIds) {
      if (active.has(stepId) || results.some((result) => result.stepId === stepId)) continue;
      const index = config.children.findIndex((child) => child.id === stepId);
      if (index < 0) continue;
      const child = config.children[index];
      const taskGraphResults = buildTaskGraphResultsMap(results);

      let shouldRun;
      try {
        shouldRun = evaluateTaskGraphCondition(child.when, taskGraphResults);
      } catch (error) {
        const reason = `Skipped because when condition could not be evaluated: ${toErrorMessage(error)}`;
        markTaskGraphStepsSkipped(status, [child.id], reason);
        results.push(skippedChildResult(child, reason, true));
        progressedWithoutActive = true;
        await updateStatus(config.statusPath, status);
        continue;
      }

      if (!shouldRun) {
        const reason = `Skipped because when condition evaluated false: ${child.when}`;
        markTaskGraphStepsSkipped(status, [child.id], reason);
        results.push(skippedChildResult(child, reason, true));
        progressedWithoutActive = true;
        await updateStatus(config.statusPath, status);
        continue;
      }

      const task = runTaskGraphStepWithRetries({
        maxAttempts: (child.retries ?? 0) + 1,
        executeAttempt: async (attempt) => {
          const taskGraphResults = buildTaskGraphResultsMap(results);
          let renderedPrompt;
          try {
            renderedPrompt = renderTaskGraphTemplate(child.prompt, taskGraphResults);
          } catch (error) {
            const promptError = error instanceof Error ? error : new Error(String(error));
            promptError.nonRetryable = true;
            throw promptError;
          }
          return await runChild(config, config.statusPath, status, child, index, renderedPrompt, attempt);
        },
        onAttemptFailure: async ({ retriesRemaining, result, error }) => {
          if (retriesRemaining <= 0) return;
          const step = status.steps[index];
          step.status = "pending";
          step.error = result?.error ?? toErrorMessage(error ?? "Task graph step failed");
          step.summary = undefined;
          step.structuredOutput = undefined;
          step.currentTool = undefined;
          step.endedAt = now();
          await updateStatus(config.statusPath, status);
        },
      })
        .then(({ attemptCount, attempts, finalResult }) => ({ stepId, result: { ...finalResult, attempt: attemptCount, attempts } }))
        .catch(async (error) => {
          const message = toErrorMessage(error);
          const attempts = Array.isArray(error?.attempts) ? error.attempts : [];
          const step = status.steps[index];
          step.status = "failed";
          step.error = message;
          step.summary = undefined;
          step.structuredOutput = undefined;
          step.endedAt = now();
          await updateStatus(config.statusPath, status);
          return { stepId, result: failedChildResult(config, child, message, error?.attemptCount ?? step.attempt ?? 1, attempts) };
        });
      active.set(stepId, task);
    }

    if (progressedWithoutActive) continue;

    if (active.size === 0) {
      const unresolvedChildren = config.children.filter((child) => !results.some((result) => result.stepId === child.id));
      if (unresolvedChildren.length === 0) break;
      const changed = markTaskGraphStepsSkipped(status, unresolvedChildren.map((child) => child.id), "Skipped because task graph dependencies could not be satisfied.");
      if (changed) await updateStatus(config.statusPath, status);
      for (const child of unresolvedChildren) {
        if (results.some((result) => result.stepId === child.id)) continue;
        results.push(skippedChildResult(child, "Skipped because task graph dependencies could not be satisfied.", false));
      }
      break;
    }

    const { stepId, result } = await Promise.race(active.values());
    active.delete(stepId);
    results.push(result);
  }

  return results;
}

// ── Main dispatch ─────────────────────────────

async function run(config) {
  if (config.mode !== "task_graph") {
    throw new Error(`Unsupported direct-runner mode: ${config.mode}. Expected task_graph.`);
  }
  await ensureDir(config.asyncDir);
  await ensureDir(config.resultsDir);
  for (const child of config.children) await ensureDir(child.sessionDir);

  const status = createInitialStatus(config);
  await writeJson(config.statusPath, status);

  const results = await runTaskGraph(config, status);
  await writeResult(config, status, results);
}

// ── Entry point ───────────────────────────────

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;

if (isMain) {
  const configPath = process.argv[2];
  if (!configPath) {
    console.error("[direct-runner] Missing config path");
    process.exitCode = 1;
  } else {
    const raw = await fs.readFile(configPath, "utf8");
    const config = JSON.parse(raw);

    process.on("SIGTERM", async () => {
      const timestamp = now();
      try {
        const statusPath = config.statusPath;
        const resultPath = config.resultPath;
        const existingStatus = JSON.parse(await fs.readFile(statusPath, "utf8").catch(() => "{}"));

        for (const step of existingStatus.steps ?? []) {
          if (step.pid) {
            try { process.kill(step.pid, "SIGTERM"); } catch { /* ignore */ }
          }
        }

        const existingResult = JSON.parse(await fs.readFile(resultPath, "utf8").catch(() => "{}"));
        const signal = renderTerminationSignal(existingStatus, existingResult, timestamp);
        await writeJson(statusPath, signal.status);
        await publishTerminalResult(resultPath, config.resultReservationPath, {
          sessionId: config.sessionId,
          runId: config.runId,
          resultId: config.resultId,
        }, signal.result);
      } catch (error) {
        console.error("[direct-runner] Failed to write termination state", error);
      } finally {
        process.exit(0);
      }
    });

    run(config).catch(async (error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error("[direct-runner] Failed", message);
      const timestamp = now();
      await writeJson(config.statusPath, {
        runId: config.runId,
        mode: config.mode,
        pid: process.pid,
        state: "failed",
        startedAt: timestamp,
        lastUpdate: timestamp,
        endedAt: timestamp,
        error: message,
        steps: (config.children ?? []).map((child, index) => ({
          index,
          id: child.id,
          agent: child.agent ?? `child-${index + 1}`,
          status: "failed",
          error: message,
          outputFile: child.outputFile,
        })),
      });
      await publishTerminalResult(config.resultPath, config.resultReservationPath, {
        sessionId: config.sessionId,
        runId: config.runId,
        resultId: config.resultId,
      }, {
        state: "failed",
        success: false,
        summary: message,
        timestamp,
      }).catch((publishError) => {
        console.error("[direct-runner] Failed to publish terminal result", toErrorMessage(publishError));
      });
      process.exitCode = 1;
    });
  }
}
