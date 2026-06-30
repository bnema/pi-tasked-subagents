// ──────────────────────────────────────────────
// Task result reducer: validate and apply subagent task reports
// ──────────────────────────────────────────────

import type { ArtifactRef, SubagentTaskReport, TaskAssignmentRecord, TaskRecord, TaskRunRecord } from "../types.js";
import { deriveTaskRunStatus } from "./task-scheduler.js";

export interface ApplyTaskReportResult {
  applied: boolean;
  errors: string[];
  warnings: string[];
}

function findTask(taskRun: TaskRunRecord, taskId: string): { task: TaskRecord; taskIndex: number } | undefined {
  const taskIndex = taskRun.tasks.findIndex((task) => task.id === taskId);
  if (taskIndex < 0) return undefined;
  return { task: taskRun.tasks[taskIndex], taskIndex };
}

function putAssignmentAttention(assignment: TaskAssignmentRecord | undefined, timestamp: number): void {
  if (!assignment) return;
  assignment.status = "attention";
  assignment.updatedAt = timestamp;
}

function putTaskAttention(taskRun: TaskRunRecord, assignment: TaskAssignmentRecord | undefined, timestamp: number): void {
  putAssignmentAttention(assignment, timestamp);
  if (assignment) {
    const found = findTask(taskRun, assignment.taskId);
    if (found) {
      found.task.status = "attention";
      found.task.updatedAt = timestamp;
    }
  }
  deriveTaskRunStatus(taskRun, timestamp);
  taskRun.status = "attention";
  taskRun.updatedAt = timestamp;
}

function validateReport(
  taskRun: TaskRunRecord,
  assignment: TaskAssignmentRecord | undefined,
  report: SubagentTaskReport,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!assignment) return { errors: [`Assignment ${report.assignmentId} not found`], warnings };
  if (report.taskRunId !== taskRun.id) errors.push(`Report taskRunId ${report.taskRunId} does not match ${taskRun.id}`);
  if (report.groupId !== assignment.groupId) errors.push(`Report groupId ${report.groupId} does not match ${assignment.groupId}`);
  if (report.taskId !== assignment.taskId) errors.push(`Report taskId ${report.taskId} does not match ${assignment.taskId}`);

  const found = findTask(taskRun, assignment.taskId);
  if (!found || found.task.groupId !== assignment.groupId) {
    const groupText = assignment.groupId ? ` in group ${assignment.groupId}` : "";
    errors.push(`Task ${assignment.taskId} not found${groupText}`);
    return { errors, warnings };
  }

  if (report.status !== "completed" && report.status !== "attention" && report.status !== "failed") {
    errors.push("Report status must be completed, attention, or failed");
  }
  if (!report.summary?.trim()) errors.push("Report summary is required");
  if (!Array.isArray(report.criteriaEvidence) || report.criteriaEvidence.length === 0) {
    errors.push("Report criteriaEvidence is required");
    return { errors, warnings };
  }

  const seen = new Set<number>();
  for (const [entryIndex, rawEntry] of (report.criteriaEvidence as unknown[]).entries()) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      errors.push(`Criteria evidence entry ${entryIndex} must be an object`);
      continue;
    }

    const entry = rawEntry as Partial<SubagentTaskReport["criteriaEvidence"][number]>;
    const criteriaIndex = entry.criteriaIndex;
    if (!Number.isInteger(criteriaIndex)) {
      errors.push("Criterion index must be an integer");
      continue;
    }
    const validatedCriteriaIndex = criteriaIndex as number;

    if (seen.has(validatedCriteriaIndex)) warnings.push(`Duplicate criteria index ${validatedCriteriaIndex}; preserving additional evidence`);
    seen.add(validatedCriteriaIndex);
    if (validatedCriteriaIndex < 0 || validatedCriteriaIndex >= found.task.criteria.length) {
      errors.push(`Criteria index ${validatedCriteriaIndex} is out of bounds`);
    }
    if (typeof entry.evidence !== "string" || !entry.evidence.trim()) errors.push(`Evidence for criteria index ${validatedCriteriaIndex} is required`);
  }

  if (report.status === "completed" && seen.size !== found.task.criteria.length) {
    errors.push("Report does not provide evidence for every criterion");
  }

  if (report.artifacts !== undefined) {
    if (!Array.isArray(report.artifacts)) {
      errors.push("Report artifacts must be an array");
    } else {
      for (const [artifactIndex, rawArtifact] of (report.artifacts as unknown[]).entries()) {
        if (!rawArtifact || typeof rawArtifact !== "object" || Array.isArray(rawArtifact)) {
          errors.push(`Artifact entry ${artifactIndex} must be an object`);
          continue;
        }

        const artifact = rawArtifact as Record<string, unknown>;
        if (typeof artifact.label !== "string" || !artifact.label.trim()) errors.push(`Artifact label for entry ${artifactIndex} is required`);
        if (typeof artifact.path !== "string" || !artifact.path.trim()) errors.push(`Artifact path for entry ${artifactIndex} is required`);
      }
    }
  }

  if (report.followUps !== undefined) {
    if (!Array.isArray(report.followUps)) {
      errors.push("Report followUps must be an array");
    } else {
      for (const [followUpIndex, followUp] of (report.followUps as unknown[]).entries()) {
        if (typeof followUp !== "string") errors.push(`Follow-up entry ${followUpIndex} must be a string`);
      }
    }
  }

  if (report.taskRunPatch !== undefined) {
    if (found.task.expansionMode !== "append_tasks") errors.push(`Task ${found.task.id} is not allowed to return taskRunPatch`);
    if (report.status !== "completed") errors.push("taskRunPatch is only allowed on completed reports");
    if (!report.taskRunPatch || typeof report.taskRunPatch !== "object" || Array.isArray(report.taskRunPatch)) {
      errors.push("Report taskRunPatch must be an object");
    } else {
      const patch = report.taskRunPatch as Record<string, unknown>;
      if (patch.groups !== undefined && !Array.isArray(patch.groups)) errors.push("Report taskRunPatch.groups must be an array");
      if (Array.isArray(patch.groups)) {
        for (const [groupIndex, group] of patch.groups.entries()) {
          if (!group || typeof group !== "object" || Array.isArray(group)) errors.push(`Report taskRunPatch.groups entry ${groupIndex} must be an object`);
        }
      }
      if (patch.tasks !== undefined && !Array.isArray(patch.tasks)) errors.push("Report taskRunPatch.tasks must be an array");
      if (Array.isArray(patch.tasks)) {
        for (const [taskIndex, task] of patch.tasks.entries()) {
          if (!task || typeof task !== "object" || Array.isArray(task)) {
            errors.push(`Report taskRunPatch.tasks entry ${taskIndex} must be an object`);
            continue;
          }
          const taskPatch = task as Record<string, unknown>;
          if (taskPatch.expansionMode !== undefined && taskPatch.expansionMode !== "append_tasks") {
            errors.push(`Report taskRunPatch.tasks entry ${taskIndex} expansionMode must be append_tasks`);
          }
        }
      }
    }
  }

  return { errors, warnings };
}

export function applySubagentTaskReport(
  taskRun: TaskRunRecord,
  report: SubagentTaskReport,
  options: { now?: number; rawResultPath?: string; expectedAssignmentId?: string } = {},
): ApplyTaskReportResult {
  const timestamp = options.now ?? Date.now();
  const assignment = taskRun.assignments.find((candidate) => candidate.id === (options.expectedAssignmentId ?? report.assignmentId));
  if (options.expectedAssignmentId && report.assignmentId !== options.expectedAssignmentId) {
    putTaskAttention(taskRun, assignment, timestamp);
    return { applied: false, errors: [`Report assignmentId ${report.assignmentId} does not match launched assignment ${options.expectedAssignmentId}`], warnings: [] };
  }
  if (assignment) {
    const found = findTask(taskRun, assignment.taskId);
    const latestAssignmentId = found?.task.assignmentIds.at(-1);
    if (latestAssignmentId && latestAssignmentId !== assignment.id) {
      putAssignmentAttention(assignment, timestamp);
      return {
        applied: false,
        errors: [`Report assignmentId ${assignment.id} is stale; latest assignment is ${latestAssignmentId}`],
        warnings: ["Ignored stale task report without mutating task evidence or status"],
      };
    }
  }

  const validation = validateReport(taskRun, assignment, report);
  if (validation.errors.length > 0) {
    putTaskAttention(taskRun, assignment, timestamp);
    return { applied: false, errors: validation.errors, warnings: validation.warnings };
  }

  const found = findTask(taskRun, assignment!.taskId)!;
  const artifacts: ArtifactRef[] = (report.artifacts ?? [])
    .filter((artifact) => artifact.label?.trim() && artifact.path?.trim())
    .map((artifact) => ({
      label: artifact.label.trim(),
      path: artifact.path.trim(),
      assignmentId: report.assignmentId,
      taskRunId: report.taskRunId,
      groupId: report.groupId,
      taskId: report.taskId,
    }));

  taskRun.artifacts = taskRun.artifacts.filter((artifact) => artifact.assignmentId !== report.assignmentId);
  for (const criterion of found.task.criteria) {
    const hadAssignmentEvidence = criterion.evidence.some((evidence) => evidence.assignmentId === report.assignmentId);
    if (!hadAssignmentEvidence) continue;
    criterion.evidence = criterion.evidence.filter((evidence) => evidence.assignmentId !== report.assignmentId);
    if (criterion.evidence.length === 0) criterion.satisfied = false;
  }

  for (const entry of report.criteriaEvidence) {
    const criterion = found.task.criteria[entry.criteriaIndex];
    if (report.status === "completed") criterion.satisfied = true;
    criterion.evidence.push({
      criterionId: criterion.id,
      assignmentId: report.assignmentId,
      summary: entry.evidence.trim(),
      artifactPath: artifacts[0]?.path,
      createdAt: timestamp,
    });
  }

  assignment!.status = report.status;
  assignment!.result = {
    assignmentId: report.assignmentId,
    status: report.status,
    summary: report.summary.trim(),
    criteriaEvidence: report.criteriaEvidence.map((entry) => ({
      criteriaIndex: entry.criteriaIndex,
      criterionId: found.task.criteria[entry.criteriaIndex].id,
      evidence: entry.evidence.trim(),
    })),
    artifacts,
    followUps: report.followUps?.map((followUp) => followUp.trim()).filter(Boolean) ?? [],
    rawResultPath: options.rawResultPath,
    createdAt: timestamp,
  };
  assignment!.completedAt = report.status === "completed" || report.status === "failed" ? timestamp : undefined;
  assignment!.updatedAt = timestamp;

  if (report.status === "failed") found.task.status = "failed";
  else if (report.status === "attention") found.task.status = "attention";
  else found.task.status = found.task.criteria.every((criterion) => criterion.satisfied) ? "completed" : "attention";
  found.task.completedAt = found.task.status === "completed" ? timestamp : undefined;
  found.task.updatedAt = timestamp;
  taskRun.artifacts.push(...artifacts);
  deriveTaskRunStatus(taskRun, timestamp);
  return { applied: true, errors: [], warnings: validation.warnings };
}

function isTaskReport(value: unknown): value is SubagentTaskReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<SubagentTaskReport>;
  return typeof input.taskRunId === "string"
    && (input.groupId === undefined || typeof input.groupId === "string")
    && typeof input.taskId === "string"
    && typeof input.assignmentId === "string"
    && (input.status === "completed" || input.status === "attention" || input.status === "failed")
    && typeof input.summary === "string"
    && Array.isArray(input.criteriaEvidence);
}

function extractBalancedJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
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
      if (depth === 0) {
        candidates.push(text.slice(start, index + 1).trim());
        break;
      }
    }
  }
  return candidates;
}

export function parseTaskReport(raw: string): SubagentTaskReport | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const fencedCandidates = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gu)].map((match) => match[1]);
  const candidates = [trimmed, ...fencedCandidates, ...extractBalancedJsonObjectCandidates(trimmed)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (isTaskReport(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}
