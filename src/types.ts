// ──────────────────────────────────────────────
// Task-run domain model for pi-tasked-subagents
// ──────────────────────────────────────────────

export const TASK_RUN_STATUSES = [
  "pending",
  "running",
  "attention",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskRunStatus = (typeof TASK_RUN_STATUSES)[number];

export const TASK_GROUP_STATUSES = [
  "pending",
  "ready",
  "running",
  "blocked",
  "attention",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskGroupStatus = (typeof TASK_GROUP_STATUSES)[number];

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
// Task-run input
// ──────────────────────────────────────────────

export interface TaskGroupInput {
  id: string;
  title?: string;
  dependsOn?: string[];
  maxConcurrency?: number;
  agentHint?: string;
  filesHint?: string[];
}

export interface TaskInput {
  id?: string;
  group?: string;
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

export interface SetTasksInput {
  taskRunId?: string;
  request?: string;
  title?: string;
  context?: string;
  groups?: TaskGroupInput[];
  tasks: TaskInput[];
  maxConcurrency?: number;
  wait?: boolean;
}

export interface PatchTaskRunInput {
  taskRunId?: string;
  groups?: TaskGroupInput[];
  tasks?: TaskInput[];
  wait?: boolean;
}

export type TaskPatchInput = Partial<Omit<TaskInput, "id">>;
export type TaskGroupPatchInput = Partial<Omit<TaskGroupInput, "id">>;

export interface EditTaskInput {
  taskRunId?: string;
  targetId: string;
  task?: TaskPatchInput;
  wait?: boolean;
}

export interface EditGroupInput {
  taskRunId?: string;
  targetId: string;
  group?: TaskGroupPatchInput;
  wait?: boolean;
}

export interface SetTasksResult {
  accepted: boolean;
  taskRunId?: string;
  errors: string[];
  dispatchScheduled: boolean;
}

export interface EditTaskResult {
  edited: boolean;
  taskRunId?: string;
  taskId?: string;
  errors: string[];
  dispatchScheduled: boolean;
}

export interface EditGroupResult {
  edited: boolean;
  taskRunId?: string;
  groupId?: string;
  errors: string[];
  dispatchScheduled: boolean;
}

export interface PatchTaskRunResult {
  patched: boolean;
  taskRunId?: string;
  errors: string[];
  dispatchScheduled: boolean;
}

export interface AttachResult {
  attached: boolean;
  targetId?: string;
  taskRunId?: string;
  report: string;
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
  groupId?: string;
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

export interface TaskGroupRecord {
  id: string;
  title: string;
  status: TaskGroupStatus;
  dependsOn: string[];
  maxConcurrency: number;
  agentHint?: string;
  filesHint?: string[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface ArtifactRef {
  label: string;
  path: string;
  assignmentId: string;
  taskRunId: string;
  groupId?: string;
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
  taskRunId: string;
  groupId?: string;
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

export interface TaskRunRecord {
  id: string;
  title: string;
  request: string;
  context: string;
  status: TaskRunStatus;
  groups: TaskGroupRecord[];
  tasks: TaskRecord[];
  assignments: TaskAssignmentRecord[];
  artifacts: ArtifactRef[];
  maxConcurrency?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface TaskedSubagentsState {
  version: 4;
  taskRuns: TaskRunRecord[];
  currentTaskRunId?: string;
  updatedAt: number;
}

// ──────────────────────────────────────────────
// Subagent report contract
// ──────────────────────────────────────────────

export interface SubagentTaskReport {
  taskRunId: string;
  groupId?: string;
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
  taskRunId: string;
  groupId?: string;
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
