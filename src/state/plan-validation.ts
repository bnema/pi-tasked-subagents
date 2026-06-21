// ──────────────────────────────────────────────
// Plan input validation and normalization
// ──────────────────────────────────────────────

import type {
  PhaseRecord,
  PlanPhaseInput,
  PlanRecord,
  PlanTaskInput,
  TaskRecord,
  ValidatedPlanInput,
} from "../types.js";

function cleanText(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function cleanId(value: string | undefined, fallback: string): string {
  const cleaned = value?.trim();
  return cleaned && /^[A-Za-z0-9_.-]+$/u.test(cleaned) ? cleaned : fallback;
}

function cleanList(values: string[] | undefined): string[] {
  return Array.isArray(values) ? values.map((value) => cleanText(value)).filter(Boolean) : [];
}

function generatedPhaseId(index: number): string {
  return `P${index + 1}`;
}

function generatedTaskId(phaseIndex: number, taskIndex: number): string {
  return `${generatedPhaseId(phaseIndex)}T${taskIndex + 1}`;
}

function addUnique(errors: string[], error: string): void {
  if (!errors.includes(error)) errors.push(error);
}

function detectCycle(ids: string[], depsFor: (id: string) => string[], label: string): string | undefined {
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (id: string, path: string[]): string | undefined => {
    if (visited.has(id)) return undefined;
    if (visiting.has(id)) return `${label} dependency cycle detected: ${[...path, id].join(" -> ")}`;
    visiting.add(id);
    for (const dep of depsFor(id)) {
      const result = visit(dep, [...path, id]);
      if (result) return result;
    }
    visiting.delete(id);
    visited.add(id);
    return undefined;
  };

  for (const id of ids) {
    const result = visit(id, []);
    if (result) return result;
  }
  return undefined;
}

export function validatePlanInput(input: ValidatedPlanInput): string[] {
  const errors: string[] = [];
  if (!cleanText(input.title) && !cleanText(input.request) && !cleanText(input.spec)) errors.push("Plan title, request, or spec is required");
  if (!cleanText(input.spec)) errors.push("Plan spec is required");
  if (input.maxConcurrency !== undefined && (!Number.isInteger(input.maxConcurrency) || input.maxConcurrency < 1)) {
    errors.push("Plan maxConcurrency must be a positive integer");
  }
  if (!Array.isArray(input.phases) || input.phases.length === 0) errors.push("Plan must contain at least one phase");

  const phaseIds: string[] = [];
  const phaseIdByIndex = new Map<number, string>();
  const phaseDeps = new Map<string, string[]>();
  const taskIds: string[] = [];
  const taskDeps = new Map<string, string[]>();

  for (const [phaseIndex, phase] of (input.phases ?? []).entries()) {
    const phaseId = cleanId(phase.id, generatedPhaseId(phaseIndex));
    if (phaseIds.includes(phaseId)) addUnique(errors, `Duplicate phase id: ${phaseId}`);
    phaseIds.push(phaseId);
    phaseIdByIndex.set(phaseIndex, phaseId);
    if (!cleanText(phase.title)) errors.push(`Phase ${phaseId} title is required`);
    if (phase.maxConcurrency !== undefined && (!Number.isInteger(phase.maxConcurrency) || phase.maxConcurrency < 1)) {
      errors.push(`Phase ${phaseId} maxConcurrency must be a positive integer`);
    }
    if (!Array.isArray(phase.tasks) || phase.tasks.length === 0) errors.push(`Phase ${phaseId} must contain at least one task`);
    phaseDeps.set(phaseId, cleanList(phase.dependsOn));

    for (const [taskIndex, task] of (phase.tasks ?? []).entries()) {
      const taskId = cleanId(task.id, generatedTaskId(phaseIndex, taskIndex));
      if (taskIds.includes(taskId)) addUnique(errors, `Duplicate task id: ${taskId}`);
      taskIds.push(taskId);
      if (!cleanText(task.text)) errors.push(`Task ${taskId} text is required`);
      const criteria = cleanList(task.criteria);
      if (criteria.length === 0) errors.push(`Task ${taskId} must have at least one criterion`);
      taskDeps.set(taskId, cleanList(task.dependsOn));
      if (task.retries !== undefined && (!Number.isInteger(task.retries) || task.retries < 0)) {
        errors.push(`Task ${taskId} retries must be a non-negative integer`);
      }
    }
  }

  const knownPhaseIds = new Set(phaseIds);
  for (const [phaseId, deps] of phaseDeps) {
    for (const dep of deps) {
      if (!knownPhaseIds.has(dep)) errors.push(`Phase ${phaseId} depends on unknown phase ${dep}`);
      if (dep === phaseId) errors.push(`Phase ${phaseId} cannot depend on itself`);
    }
  }

  const knownTaskIds = new Set(taskIds);
  for (const [taskId, deps] of taskDeps) {
    for (const dep of deps) {
      if (!knownTaskIds.has(dep)) errors.push(`Task ${taskId} depends on unknown task ${dep}`);
      if (dep === taskId) errors.push(`Task ${taskId} cannot depend on itself`);
    }
  }

  const phaseCycle = detectCycle(phaseIds, (id) => phaseDeps.get(id) ?? [], "Phase");
  if (phaseCycle) errors.push(phaseCycle);
  const taskCycle = detectCycle(taskIds, (id) => taskDeps.get(id) ?? [], "Task");
  if (taskCycle) errors.push(taskCycle);

  return errors;
}

function normalizeTask(phaseIndex: number, taskIndex: number, input: PlanTaskInput, now: number): TaskRecord {
  const taskId = cleanId(input.id, generatedTaskId(phaseIndex, taskIndex));
  return {
    id: taskId,
    text: cleanText(input.text),
    status: "pending",
    criteria: cleanList(input.criteria).map((criterion, criterionIndex) => ({
      id: `C${criterionIndex + 1}`,
      text: criterion,
      satisfied: false,
      evidence: [],
    })),
    dependsOn: cleanList(input.dependsOn),
    assignmentIds: [],
    agentHint: cleanText(input.agentHint) || undefined,
    filesHint: cleanList(input.filesHint).length > 0 ? cleanList(input.filesHint) : undefined,
    cwd: cleanText(input.cwd) || undefined,
    retries: input.retries,
    outputMode: input.outputMode,
    outputSchema: cleanText(input.outputSchema) || undefined,
    when: cleanText(input.when) || undefined,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizePhase(phaseIndex: number, input: PlanPhaseInput, now: number): PhaseRecord {
  const phaseId = cleanId(input.id, generatedPhaseId(phaseIndex));
  return {
    id: phaseId,
    title: cleanText(input.title),
    status: phaseIndex === 0 && cleanList(input.dependsOn).length === 0 ? "ready" : "pending",
    tasks: input.tasks.map((task, taskIndex) => normalizeTask(phaseIndex, taskIndex, task, now)),
    dependsOn: cleanList(input.dependsOn),
    goal: cleanText(input.goal) || undefined,
    agentHint: cleanText(input.agentHint) || undefined,
    filesHint: cleanList(input.filesHint).length > 0 ? cleanList(input.filesHint) : undefined,
    brief: cleanText(input.brief) || undefined,
    maxConcurrency: input.maxConcurrency,
    createdAt: now,
    updatedAt: now,
  };
}

export function normalizePlanInput(
  input: ValidatedPlanInput,
  options: { planId: string; now?: number },
): { plan?: PlanRecord; errors: string[] } {
  const errors = validatePlanInput(input);
  if (errors.length > 0) return { errors };

  const timestamp = options.now ?? Date.now();
  const spec = cleanText(input.spec);
  const request = cleanText(input.request) || spec;
  const title = cleanText(input.title) || cleanText(input.request) || spec.slice(0, 80);
  const phases = input.phases.map((phase, phaseIndex) => normalizePhase(phaseIndex, phase, timestamp));

  return {
    errors: [],
    plan: {
      id: input.id ? cleanId(input.id, options.planId) : options.planId,
      title,
      request,
      spec,
      status: "running",
      phases,
      assignments: [],
      artifacts: [],
      maxConcurrency: input.maxConcurrency,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}
