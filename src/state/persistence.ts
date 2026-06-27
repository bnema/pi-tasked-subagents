// ──────────────────────────────────────────────
// Persistence for task-run tasked-subagents state
// ──────────────────────────────────────────────

import { ENTRY_TYPE_STATE, STATE_VERSION } from "../defaults.js";
import type { TaskAssignmentRecord, TaskRecord, TaskRunRecord, TaskedSubagentsState } from "../types.js";
import { createEmptyState, deserializeState, ensureState, serializeState } from "./store.js";

export interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
}

function parseEntryData(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

function objectRecord(raw: unknown): Record<string, unknown> | undefined {
  return typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : undefined;
}

function arrayWouldShrink(raw: unknown, normalizedLength: number): boolean {
  return Array.isArray(raw) && raw.length !== normalizedLength;
}

function normalizedOptionalString(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const value = raw.trim();
    return value ? value : undefined;
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  return undefined;
}

function hasPersistedScalarContent(input: Record<string, unknown>, fields: string[]): boolean {
  return fields.some((field) => normalizedOptionalString(input[field]) !== undefined);
}

function hasPersistedArrayContent(input: Record<string, unknown>, fields: string[]): boolean {
  return fields.some((field) => Array.isArray(input[field]) && input[field].length > 0);
}

function hasPersistedObjectContent(input: Record<string, unknown>, scalarFields: string[], arrayFields: string[]): boolean {
  return hasPersistedScalarContent(input, scalarFields) || hasPersistedArrayContent(input, arrayFields);
}

function optionalStringWouldDiffer(raw: unknown, normalized: string | undefined): boolean {
  const rawValue = normalizedOptionalString(raw);
  return rawValue !== undefined && rawValue !== normalized;
}

function hasPersistedResultContent(input: Record<string, unknown>): boolean {
  return hasPersistedObjectContent(
    input,
    ["status", "summary", "rawResultPath"],
    ["criteriaEvidence", "artifacts", "followUps"],
  );
}

function hasPersistedLaunchRefContent(input: Record<string, unknown>): boolean {
  return hasPersistedObjectContent(
    input,
    ["runId", "asyncId", "asyncDir", "resultPath", "sessionFile", "artifactPath"],
    ["assignments"],
  );
}

function hasPersistedLaunchAssignmentContent(input: Record<string, unknown>): boolean {
  return hasPersistedObjectContent(input, ["assignmentId", "runId", "resultPath"], []);
}

function hasLossyLaunchAssignmentNormalization(
  rawAssignment: unknown,
  assignment: NonNullable<TaskAssignmentRecord["launchRef"]>["assignments"][number] | undefined,
): boolean {
  const input = objectRecord(rawAssignment);
  if (!input || !hasPersistedLaunchAssignmentContent(input)) return false;
  if (!assignment) return true;
  return optionalStringWouldDiffer(input.assignmentId, assignment.assignmentId)
    || optionalStringWouldDiffer(input.runId, assignment.runId)
    || optionalStringWouldDiffer(input.resultPath, assignment.resultPath);
}

function hasLossyLaunchAssignmentsNormalization(
  rawAssignments: unknown,
  launchRef: TaskAssignmentRecord["launchRef"],
): boolean {
  if (!Array.isArray(rawAssignments)) return false;
  if (!launchRef) return rawAssignments.some((entry) => {
    const input = objectRecord(entry);
    return input ? hasPersistedLaunchAssignmentContent(input) : false;
  });
  return rawAssignments.length > launchRef.assignments.length
    || rawAssignments.some((entry, index) => hasLossyLaunchAssignmentNormalization(entry, launchRef.assignments[index]));
}



function hasLossyTaskCriteriaNormalization(rawTask: unknown, task: TaskRecord): boolean {
  const input = objectRecord(rawTask);
  if (!input) return false;
  if (arrayWouldShrink(input.criteria, task.criteria.length)) return true;
  if (!Array.isArray(input.criteria)) return false;

  return task.criteria.some((criterion, index) => {
    const rawCriterion = objectRecord(input.criteria[index]);
    return rawCriterion ? arrayWouldShrink(rawCriterion.evidence, criterion.evidence.length) : false;
  });
}

function hasLossyResultNormalization(rawResult: unknown, result: TaskAssignmentRecord["result"]): boolean {
  const input = objectRecord(rawResult);
  if (!input) return false;
  if (!result) return hasPersistedResultContent(input);
  return arrayWouldShrink(input.criteriaEvidence, result.criteriaEvidence.length)
    || arrayWouldShrink(input.artifacts, result.artifacts.length)
    || arrayWouldShrink(input.followUps, result.followUps.length)
    || optionalStringWouldDiffer(input.rawResultPath, result.rawResultPath);
}

function hasLossyLaunchRefNormalization(rawLaunchRef: unknown, launchRef: TaskAssignmentRecord["launchRef"]): boolean {
  const input = objectRecord(rawLaunchRef);
  if (!input) return false;
  if (!launchRef) return hasPersistedLaunchRefContent(input);
  return hasLossyLaunchAssignmentsNormalization(input.assignments, launchRef);
}

function hasLossyAssignmentNormalization(rawAssignment: unknown, assignment: TaskAssignmentRecord): boolean {
  const input = objectRecord(rawAssignment);
  return input
    ? hasLossyResultNormalization(input.result, assignment.result)
      || hasLossyLaunchRefNormalization(input.launchRef, assignment.launchRef)
    : false;
}

function hasLossyTaskRunNormalization(rawTaskRun: unknown, taskRun: TaskRunRecord): boolean {
  const input = objectRecord(rawTaskRun);
  if (!input) return false;
  if (arrayWouldShrink(input.groups, taskRun.groups.length)) return true;
  if (arrayWouldShrink(input.tasks, taskRun.tasks.length)) return true;
  if (arrayWouldShrink(input.assignments, taskRun.assignments.length)) return true;
  if (arrayWouldShrink(input.artifacts, taskRun.artifacts.length)) return true;

  if (Array.isArray(input.tasks) && taskRun.tasks.some((task, index) => hasLossyTaskCriteriaNormalization(input.tasks[index], task))) {
    return true;
  }
  return Array.isArray(input.assignments)
    && taskRun.assignments.some((assignment, index) => hasLossyAssignmentNormalization(input.assignments[index], assignment));
}

function hasLossyStateNormalization(input: Record<string, unknown>, state: TaskedSubagentsState): boolean {
  if (!Array.isArray(input.taskRuns)) return true;
  if (input.taskRuns.length !== state.taskRuns.length) return true;
  return state.taskRuns.some((taskRun, index) => hasLossyTaskRunNormalization(input.taskRuns[index], taskRun));
}

function normalizeCurrentStateEntryData(data: unknown): TaskedSubagentsState | undefined {
  const parsed = parseEntryData(data);
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const input = parsed as Record<string, unknown>;
  if (input.version !== STATE_VERSION || !Array.isArray(input.taskRuns)) return undefined;
  const state = ensureState(parsed);
  if (hasLossyStateNormalization(input, state)) return undefined;
  return state;
}

export function restoreStateFromSessionEntries(entries: SessionEntry[]): TaskedSubagentsState {
  let foundState: TaskedSubagentsState | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE_STATE || entry.data === undefined || entry.data === null) continue;
    const state = normalizeCurrentStateEntryData(entry.data);
    if (!state) continue;
    foundState = state;
  }
  return foundState ?? createEmptyState();
}

export function stateToEntryData(state: TaskedSubagentsState): unknown {
  return JSON.parse(serializeState(state));
}

export function stateFromEntryData(data: unknown): TaskedSubagentsState {
  if (typeof data === "string") return deserializeState(data);
  return ensureState(data);
}

export function buildStateEntryData(state: TaskedSubagentsState): object {
  return {
    version: state.version,
    taskRuns: state.taskRuns,
    currentTaskRunId: state.currentTaskRunId ?? null,
    updatedAt: state.updatedAt,
  };
}
