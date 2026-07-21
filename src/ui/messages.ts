// ──────────────────────────────────────────────
// Message payloads and renderers for task assignments
// ──────────────────────────────────────────────

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { ArtifactRef, TaskAssignmentRecord, TaskRunRecord } from "../types.js";
import {
  ENTRY_TYPE_ARTIFACT,
  ENTRY_TYPE_ATTENTION,
  ENTRY_TYPE_ATTENTION_REMINDER,
  ENTRY_TYPE_COMPLETION,
  ENTRY_TYPE_FAILURE,
  ENTRY_TYPE_LAUNCH,
} from "../defaults.js";

export type AssignmentMessageKind = "launch" | "completion" | "failure" | "attention" | "artifact";

export interface AssignmentMessagePayload {
  kind: AssignmentMessageKind;
  taskRunId: string;
  groupId?: string;
  taskId: string;
  assignment: TaskAssignmentRecord;
  summary: string;
  preview?: string;
}

export interface ArtifactMessagePayload {
  kind: "artifact";
  taskRunId: string;
  groupId?: string;
  taskId: string;
  assignmentId: string;
  label: string;
  path: string;
  summary: string;
  preview?: string;
}

export function statusLabel(status: string): string {
  switch (status) {
    case "queued": return "QUEUED";
    case "pending": return "PENDING";
    case "ready": return "READY";
    case "running": return "RUNNING";
    case "blocked": return "BLOCKED";
    case "attention": return "ATTN";
    case "completed": return "DONE";
    case "failed": return "FAIL";
    case "cancelled": return "CANCELLED";
    case "paused": return "PAUSED";
    case "skipped": return "SKIPPED";
    default: return status.toUpperCase();
  }
}

function messageKindColor(kind: string): string {
  if (kind === "launch") return "accent";
  if (kind === "completion") return "success";
  if (kind === "failure") return "error";
  if (kind === "attention") return "warning";
  if (kind === "artifact") return "accent";
  return "muted";
}

function messageKindLabel(kind: string): string {
  if (kind === "launch") return "ASSIGNMENT";
  if (kind === "completion") return "TASK DONE";
  if (kind === "failure") return "TASK FAIL";
  if (kind === "attention") return "TASK ATTN";
  if (kind === "artifact") return "ARTIFACT";
  return kind.toUpperCase();
}

function assignmentTitle(assignment: TaskAssignmentRecord): string {
  return [assignment.groupId, assignment.taskId].filter(Boolean).join("/");
}

function makeAssignmentPayload(kind: AssignmentMessageKind, taskRun: TaskRunRecord, assignment: TaskAssignmentRecord, preview?: string): AssignmentMessagePayload {
  const title = assignmentTitle(assignment);
  const summary = `${messageKindLabel(kind)} · ${taskRun.id} · ${title} · ${assignment.agent}`;
  return { kind, taskRunId: taskRun.id, groupId: assignment.groupId, taskId: assignment.taskId, assignment, summary, preview };
}

export function createLaunchMessagePayload(taskRun: TaskRunRecord, assignment: TaskAssignmentRecord): AssignmentMessagePayload {
  return makeAssignmentPayload("launch", taskRun, assignment, `Use /tasked-subagents status ${assignment.id}`);
}

export function createCompletionMessagePayload(taskRun: TaskRunRecord, assignment: TaskAssignmentRecord): AssignmentMessagePayload {
  return makeAssignmentPayload("completion", taskRun, assignment, assignment.result?.summary ?? `Use /tasked-subagents result ${assignment.id}`);
}

export function createFailureMessagePayload(taskRun: TaskRunRecord, assignment: TaskAssignmentRecord): AssignmentMessagePayload {
  return makeAssignmentPayload("failure", taskRun, assignment, assignment.result?.summary ?? `Use /tasked-subagents status ${assignment.id}`);
}

export function createAttentionMessagePayload(taskRun: TaskRunRecord, assignment: TaskAssignmentRecord): AssignmentMessagePayload {
  return makeAssignmentPayload("attention", taskRun, assignment, assignment.result?.summary ?? `Use /tasked-subagents inspect ${assignment.id}`);
}

export function createArtifactMessagePayload(_taskRun: TaskRunRecord, artifact: ArtifactRef): ArtifactMessagePayload {
  return {
    kind: "artifact",
    taskRunId: artifact.taskRunId,
    groupId: artifact.groupId,
    taskId: artifact.taskId,
    assignmentId: artifact.assignmentId,
    label: artifact.label,
    path: artifact.path,
    summary: `Artifact · ${artifact.label} · ${artifact.taskRunId}/${artifact.taskId}`,
    preview: `Path: ${artifact.path}`,
  };
}

function firstPreviewLine(preview: unknown): string | undefined {
  return typeof preview === "string" ? preview.split("\n", 1)[0] : undefined;
}

export function formatAssignmentMessageBody(payload: AssignmentMessagePayload, expanded: boolean): string {
  if (!payload.preview) return payload.summary;
  return expanded ? `${payload.summary}\n${payload.preview}` : `${payload.summary}\n${firstPreviewLine(payload.preview) ?? ""}`.trimEnd();
}

export function renderAssignmentMessageText(
  payload: AssignmentMessagePayload,
  expanded: boolean,
  theme?: { fg(color: string, text: string): string; bold(text: string): string },
): string {
  const label = theme ? theme.fg(messageKindColor(payload.kind), `[${messageKindLabel(payload.kind)}]`) : `[${messageKindLabel(payload.kind)}]`;
  const title = assignmentTitle(payload.assignment);
  const lines = [
    `${label} ${theme ? theme.bold(title) : title}`,
    [`taskRun ${payload.taskRunId}`, payload.groupId ? `group ${payload.groupId}` : undefined, `agent ${payload.assignment.agent}`, statusLabel(payload.assignment.status)].filter(Boolean).join(" · "),
  ];
  if (payload.preview) lines.push(expanded ? payload.preview : firstPreviewLine(payload.preview) ?? "");
  return lines.join("\n");
}

export function renderArtifactMessageText(
  payload: ArtifactMessagePayload,
  expanded: boolean,
  theme?: { fg(color: string, text: string): string; bold(text: string): string },
): string {
  const header = `${theme?.fg("accent", "[ARTIFACT]") ?? "[ARTIFACT]"} ${theme?.bold(payload.label) ?? payload.label}`;
  const lines = [header, [`taskRun ${payload.taskRunId}`, payload.groupId ? `group ${payload.groupId}` : undefined, `task ${payload.taskId}`, `assignment ${payload.assignmentId}`].filter(Boolean).join(" · ")];
  if (expanded) lines.push(payload.path);
  return lines.join("\n");
}

export function assignmentMessageKindToEntryType(kind: AssignmentMessageKind): string {
  switch (kind) {
    case "launch": return ENTRY_TYPE_LAUNCH;
    case "completion": return ENTRY_TYPE_COMPLETION;
    case "failure": return ENTRY_TYPE_FAILURE;
    case "attention": return ENTRY_TYPE_ATTENTION;
    case "artifact": return ENTRY_TYPE_ARTIFACT;
  }
}

function isAssignmentPayload(value: unknown): value is AssignmentMessagePayload {
  return typeof value === "object" && value !== null && "assignment" in value && "summary" in value && "taskRunId" in value;
}

function isArtifactPayload(value: unknown): value is ArtifactMessagePayload {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "artifact" && "taskRunId" in value && "assignmentId" in value;
}

function renderAssignmentMessage(
  message: { content: string; details?: unknown },
  expanded: boolean,
  theme?: { fg(color: string, text: string): string; bg(color: string, text: string): string; bold(text: string): string },
) {
  const payload = isAssignmentPayload(message.details) ? message.details : undefined;
  const text = payload ? renderAssignmentMessageText(payload, expanded, theme) : message.content;
  return { render: () => [text], invalidate() {}, dispose() {} };
}

function renderArtifactMessage(
  message: { content: string; details?: unknown },
  expanded: boolean,
  theme?: { fg(color: string, text: string): string; bg(color: string, text: string): string; bold(text: string): string },
) {
  const payload = isArtifactPayload(message.details) ? message.details : undefined;
  const text = payload ? renderArtifactMessageText(payload, expanded, theme) : message.content;
  return { render: () => [text], invalidate() {}, dispose() {} };
}

export function registerMessageRenderers(pi: ExtensionAPI): void {
  const register = (
    customType: string,
    renderer: (message: { content: string; details?: unknown }, options: { expanded: boolean }, theme: unknown) => ReturnType<typeof renderAssignmentMessage>,
  ) => pi.registerMessageRenderer(customType, renderer as never);

  register(ENTRY_TYPE_LAUNCH, (message, options, theme) => renderAssignmentMessage(message, options.expanded, theme as never));
  register(ENTRY_TYPE_COMPLETION, (message, options, theme) => renderAssignmentMessage(message, options.expanded, theme as never));
  register(ENTRY_TYPE_FAILURE, (message, options, theme) => renderAssignmentMessage(message, options.expanded, theme as never));
  register(ENTRY_TYPE_ATTENTION, (message, options, theme) => renderAssignmentMessage(message, options.expanded, theme as never));
  register(ENTRY_TYPE_ATTENTION_REMINDER, (message) => ({ render: () => message.content.split("\n"), invalidate() {}, dispose() {} }));
  register(ENTRY_TYPE_ARTIFACT, (message, options, theme) => renderArtifactMessage(message, options.expanded, theme as never));
}
