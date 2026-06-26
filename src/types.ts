// ──────────────────────────────────────────────
// Plan-first domain model for pi-tasked-subagents
// ──────────────────────────────────────────────

export const PLAN_STATUSES = [
  "pending",
  "running",
  "attention",
  "completed",
  "failed",
  "cancelled",
] as const;

export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PHASE_STATUSES = [
  "pending",
  "ready",
  "running",
  "blocked",
  "attention",
  "completed",
  "failed",
  "cancelled",
] as const;

export type PhaseStatus = (typeof PHASE_STATUSES)[number];

export const TASK_STATUSES = [
  "pending",
  "ready",
  "running",
  "blocked",
  "attention",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ASSIGNMENT_STATUSES = [
  "queued",
  "running",
  "blocked",
  "attention",
  "completed",
  "failed",
  "cancelled",
  "paused",
  "skipped",
] as const;

export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export type RunStatus = AssignmentStatus;

export type TaskReportStatus = "completed" | "attention" | "failed";
export type OutputMode = "text" | "json";

// ──────────────────────────────────────────────
// Plan input
// ──────────────────────────────────────────────

export interface PlanTaskInput {
  id?: string;
  text: string;
  criteria: string[];
  dependsOn?: string[];
  agentHint?: string;
  filesHint?: string[];
  cwd?: string;
  retries?: number;
  outputMode?: OutputMode;
  outputSchema?: string;
  when?: string;
}

export interface PlanPhaseInput {
  id?: string;
  title: string;
  goal?: string;
  dependsOn?: string[];
  agentHint?: string;
  filesHint?: string[];
  brief?: string;
  maxConcurrency?: number;
  tasks: PlanTaskInput[];
}

export interface ValidatedPlanInput {
  id?: string;
  request?: string;
  title?: string;
  spec: string;
  phases: PlanPhaseInput[];
  maxConcurrency?: number;
}

export interface EditPlanInput {
  planId?: string;
  targetId?: string;
  request?: string;
  title?: string;
  spec?: string;
  phase?: Partial<PlanPhaseInput>;
  task?: Partial<PlanTaskInput>;
}

export interface AcceptedPlanResult {
  accepted: boolean;
  planId?: string;
  errors: string[];
  dispatchScheduled: boolean;
}

export interface EditPlanResult {
  edited: boolean;
  planId?: string;
  targetId?: string;
  errors: string[];
  dispatchScheduled: boolean;
}

// ──────────────────────────────────────────────
// Persisted domain records
// ──────────────────────────────────────────────

export interface TaskCriterion {
  id: string;
  text: string;
  satisfied: boolean;
  evidence: TaskEvidence[];
}

export interface TaskEvidence {
  criterionId: string;
  assignmentId: string;
  summary: string;
  artifactPath?: string;
  createdAt: number;
}

export interface TaskRecord {
  id: string;
  text: string;
  status: TaskStatus;
  criteria: TaskCriterion[];
  dependsOn: string[];
  assignmentIds: string[];
  agentHint?: string;
  filesHint?: string[];
  cwd?: string;
  retries?: number;
  outputMode?: OutputMode;
  outputSchema?: string;
  when?: string;
  continuation?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface PhaseRecord {
  id: string;
  title: string;
  status: PhaseStatus;
  tasks: TaskRecord[];
  dependsOn: string[];
  goal?: string;
  agentHint?: string;
  filesHint?: string[];
  brief?: string;
  maxConcurrency?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface ArtifactRef {
  label: string;
  path: string;
  assignmentId: string;
  phaseId: string;
  taskId: string;
}

export interface TaskResultRecord {
  assignmentId: string;
  status: TaskReportStatus;
  summary: string;
  criteriaEvidence: Array<{
    criteriaIndex: number;
    criterionId: string;
    evidence: string;
  }>;
  artifacts: ArtifactRef[];
  followUps: string[];
  rawResultPath?: string;
  createdAt: number;
}

export interface TaskAssignmentRecord {
  id: string;
  planId: string;
  phaseId: string;
  taskId: string;
  agent: string;
  prompt: string;
  status: AssignmentStatus;
  runId?: string;
  launchRef?: SubagentRunHandle;
  result?: TaskResultRecord;
  currentTool?: string;
  lastActionAt?: number;
  lastActionSummary?: string;
  recentActivity?: string[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface PlanRecord {
  id: string;
  title: string;
  request: string;
  spec: string;
  status: PlanStatus;
  phases: PhaseRecord[];
  assignments: TaskAssignmentRecord[];
  artifacts: ArtifactRef[];
  maxConcurrency?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface TaskedSubagentsState {
  version: 3;
  plans: PlanRecord[];
  currentPlanId?: string;
  updatedAt: number;
}

// ──────────────────────────────────────────────
// Subagent report contract
// ──────────────────────────────────────────────

export interface SubagentTaskReport {
  planId: string;
  phaseId: string;
  taskId: string;
  assignmentId: string;
  status: TaskReportStatus;
  summary: string;
  criteriaEvidence: Array<{
    criteriaIndex: number;
    evidence: string;
  }>;
  artifacts?: Array<{ label: string; path: string }>;
  followUps?: string[];
}

// ──────────────────────────────────────────────
// Subagent runtime boundary
// ──────────────────────────────────────────────

export interface SubagentRunAssignmentHandle {
  assignmentId: string;
  runId: string;
  resultPath?: string;
}

export interface SubagentRunHandle {
  runId: string;
  asyncId: string;
  asyncDir?: string;
  resultPath?: string;
  sessionFile?: string;
  artifactPath?: string;
  assignments: SubagentRunAssignmentHandle[];
}

export interface RunProgressStepSnapshot {
  id?: string;
  status?: string;
  agent?: string;
  currentTool?: string;
  lastActionAt?: number;
  lastActionSummary?: string;
  recentActivity?: string[];
}

export interface RunProgressSnapshot {
  runId: string;
  status: RunStatus;
  steps: RunProgressStepSnapshot[];
}

export interface RunCounts {
  queued: number;
  running: number;
  blocked: number;
  attention: number;
  completed: number;
  failed: number;
  cancelled: number;
  paused: number;
  skipped: number;
}

export interface LaunchTaskEntry {
  assignmentId: string;
  phaseId: string;
  taskId: string;
  agent: string;
  prompt: string;
  taskSummary: string;
  dependsOn?: string[];
  retries?: number;
  outputMode?: OutputMode;
  outputSchema?: string;
  when?: string;
  cwd?: string;
}

export interface LaunchTaskGraphRequest {
  runId: string;
  title: string;
  taskSummary: string;
  tasks: LaunchTaskEntry[];
  maxConcurrency?: number;
  cwd?: string;
}

export interface SubagentRuntime<Context = unknown> {
  launchTaskGraph(request: LaunchTaskGraphRequest, ctx: Context): Promise<SubagentRunHandle>;
  stopRun(handle: SubagentRunHandle, ctx: Context): Promise<boolean>;
  cancelRun(handle: SubagentRunHandle, ctx: Context): Promise<boolean>;
  waitForRunSignal(
    handle: SubagentRunHandle | undefined,
    options?: {
      timeoutMs?: number;
      signal?: AbortSignal;
      ctx?: Context;
      onUpdate?: (snapshot: RunProgressSnapshot) => void | Promise<void>;
    },
  ): Promise<RunStatus>;
  getRunResult(handle: SubagentRunHandle): Promise<string | undefined>;
  getSnapshot(): { assignments: TaskAssignmentRecord[]; counts: RunCounts };
}
