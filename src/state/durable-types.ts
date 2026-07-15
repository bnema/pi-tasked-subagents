import type { ArtifactRef, AssignmentStatus, TaskResultRecord } from "../types.js";

/** Compact immutable record appended to Pi session history. */
export interface StatePointerV5 {
  version: 5;
  checkpointId: string;
  currentTaskRunId?: string;
  sequence: number;
  writtenAt: number;
}

/** A digest-addressed object whose kind prevents cross-record interpretation. */
export interface StoredObject<T> {
  storeVersion: 1;
  kind: "checkpoint" | "task-run" | "assignment";
  payload: T;
}

export interface CompletedRunSummary {
  taskRunId: string;
  title: string;
  status: "completed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  groupCount: number;
  taskCount: number;
  assignmentCount: number;
  assignmentArchiveIds: string[];
}

export interface RecoverableRunReference {
  taskRunId: string;
  status: "pending" | "running" | "attention" | "failed";
  objectId: string;
  updatedAt: number;
}

export interface RecentAssignmentReference {
  assignmentId: string;
  assignmentIdHash: string;
  archiveId: string;
  resultId?: string;
}

export interface CheckpointManifestV1 {
  checkpointVersion: 1;
  sessionId: string;
  sequence: number;
  currentTaskRunId?: string;
  recoverableRuns: RecoverableRunReference[];
  recentCompleted: CompletedRunSummary[];
  recentAssignmentRefs: RecentAssignmentReference[];
  updatedAt: number;
}

export interface AssignmentArchiveV1 {
  assignmentId: string;
  taskRunId: string;
  groupId?: string;
  taskId: string;
  status: AssignmentStatus;
  summary: string;
  criteriaEvidence: TaskResultRecord["criteriaEvidence"];
  artifacts: ArtifactRef[];
  followUps: string[];
  runId: string;
  resultId?: string;
  resultUnavailableReason?: "missing-legacy-result";
  completedAt: number;
  detailOmitted?: true;
}
