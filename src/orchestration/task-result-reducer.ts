// ──────────────────────────────────────────────
// Task result reducer: validate and apply subagent task reports
// ──────────────────────────────────────────────

import type { ArtifactRef, PlanRecord, SubagentTaskReport, TaskAssignmentRecord, TaskRecord } from "../types.js";
import { derivePlanStatus } from "./task-scheduler.js";

export interface ApplyTaskReportResult {
  applied: boolean;
  errors: string[];
  warnings: string[];
}

function findTask(plan: PlanRecord, phaseId: string, taskId: string): { task: TaskRecord; phaseIndex: number; taskIndex: number } | undefined {
  const phaseIndex = plan.phases.findIndex((phase) => phase.id === phaseId);
  if (phaseIndex < 0) return undefined;
  const taskIndex = plan.phases[phaseIndex].tasks.findIndex((task) => task.id === taskId);
  if (taskIndex < 0) return undefined;
  return { task: plan.phases[phaseIndex].tasks[taskIndex], phaseIndex, taskIndex };
}

function putAssignmentAttention(assignment: TaskAssignmentRecord | undefined, timestamp: number): void {
  if (!assignment) return;
  assignment.status = "attention";
  assignment.updatedAt = timestamp;
}

function putTaskAttention(plan: PlanRecord, assignment: TaskAssignmentRecord | undefined, timestamp: number): void {
  putAssignmentAttention(assignment, timestamp);
  if (assignment) {
    const found = findTask(plan, assignment.phaseId, assignment.taskId);
    if (found) {
      found.task.status = "attention";
      found.task.updatedAt = timestamp;
      plan.phases[found.phaseIndex].status = "attention";
      plan.phases[found.phaseIndex].updatedAt = timestamp;
    }
  }
  plan.status = "attention";
  plan.updatedAt = timestamp;
}

function validateReport(plan: PlanRecord, assignment: TaskAssignmentRecord | undefined, report: SubagentTaskReport): string[] {
  const errors: string[] = [];
  if (!assignment) return [`Assignment ${report.assignmentId} not found`];
  if (report.planId !== plan.id) errors.push(`Report planId ${report.planId} does not match ${plan.id}`);
  if (report.phaseId !== assignment.phaseId) errors.push(`Report phaseId ${report.phaseId} does not match ${assignment.phaseId}`);
  if (report.taskId !== assignment.taskId) errors.push(`Report taskId ${report.taskId} does not match ${assignment.taskId}`);
  const found = findTask(plan, assignment.phaseId, assignment.taskId);
  if (!found) {
    errors.push(`Task ${assignment.taskId} not found in phase ${assignment.phaseId}`);
    return errors;
  }

  if (report.status !== "completed" && report.status !== "attention" && report.status !== "failed") {
    errors.push("Report status must be completed, attention, or failed");
  }
  if (!report.summary?.trim()) errors.push("Report summary is required");
  if (!Array.isArray(report.criteriaEvidence) || report.criteriaEvidence.length === 0) {
    errors.push("Report criteriaEvidence is required");
    return errors;
  }

  const seen = new Set<number>();
  for (const entry of report.criteriaEvidence) {
    if (!Number.isInteger(entry.criteriaIndex)) errors.push("Criterion index must be an integer");
    if (seen.has(entry.criteriaIndex)) errors.push(`Duplicate criteria index ${entry.criteriaIndex}`);
    seen.add(entry.criteriaIndex);
    if (entry.criteriaIndex < 0 || entry.criteriaIndex >= found.task.criteria.length) {
      errors.push(`Criteria index ${entry.criteriaIndex} is out of bounds`);
    }
    if (!entry.evidence?.trim()) errors.push(`Evidence for criteria index ${entry.criteriaIndex} is required`);
  }

  if (report.status === "completed" && seen.size !== found.task.criteria.length) {
    errors.push("Report does not provide evidence for every criterion");
  }

  return errors;
}

export function applySubagentTaskReport(
  plan: PlanRecord,
  report: SubagentTaskReport,
  options: { now?: number; rawResultPath?: string; expectedAssignmentId?: string } = {},
): ApplyTaskReportResult {
  const timestamp = options.now ?? Date.now();
  const assignment = plan.assignments.find((candidate) => candidate.id === (options.expectedAssignmentId ?? report.assignmentId));
  if (options.expectedAssignmentId && report.assignmentId !== options.expectedAssignmentId) {
    putTaskAttention(plan, assignment, timestamp);
    return { applied: false, errors: [`Report assignmentId ${report.assignmentId} does not match launched assignment ${options.expectedAssignmentId}`], warnings: [] };
  }
  if (assignment) {
    const found = findTask(plan, assignment.phaseId, assignment.taskId);
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
  const errors = validateReport(plan, assignment, report);
  if (errors.length > 0) {
    putTaskAttention(plan, assignment, timestamp);
    return { applied: false, errors, warnings: [] };
  }

  const found = findTask(plan, report.phaseId, report.taskId)!;
  const artifacts: ArtifactRef[] = (report.artifacts ?? [])
    .filter((artifact) => artifact.label?.trim() && artifact.path?.trim())
    .map((artifact) => ({
      label: artifact.label.trim(),
      path: artifact.path.trim(),
      assignmentId: report.assignmentId,
      phaseId: report.phaseId,
      taskId: report.taskId,
    }));

  for (const entry of report.criteriaEvidence) {
    const criterion = found.task.criteria[entry.criteriaIndex];
    criterion.satisfied = true;
    criterion.evidence.push({
      criterionId: criterion.id,
      assignmentId: report.assignmentId,
      summary: entry.evidence.trim(),
      artifactPath: artifacts[0]?.path,
      createdAt: timestamp,
    });
  }

  assignment!.status = report.status === "completed" ? "completed" : report.status;
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
  plan.artifacts.push(...artifacts);
  derivePlanStatus(plan, timestamp);
  return { applied: true, errors: [], warnings: [] };
}

function isTaskReport(value: unknown): value is SubagentTaskReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Partial<SubagentTaskReport>;
  return typeof input.planId === "string"
    && typeof input.phaseId === "string"
    && typeof input.taskId === "string"
    && typeof input.assignmentId === "string"
    && (input.status === "completed" || input.status === "attention" || input.status === "failed")
    && typeof input.summary === "string"
    && Array.isArray(input.criteriaEvidence);
}

function extractBalancedJsonObjectCandidate(text: string): string | undefined {
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

export function parseTaskReport(raw: string): SubagentTaskReport | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const candidates = [trimmed, /```(?:json)?\s*\n([\s\S]*?)\n```/u.exec(trimmed)?.[1], extractBalancedJsonObjectCandidate(trimmed)];
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
