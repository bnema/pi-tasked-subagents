import type { AssignmentUsage } from "../assignment-usage.js";

export function emptyUsage(): AssignmentUsage;
export function parsePiMessageUsage(raw: unknown): Omit<AssignmentUsage, "assistantCalls" | "toolCalls" | "models"> | undefined;
export function accumulateUsage(base: AssignmentUsage, delta: Partial<AssignmentUsage> | undefined): AssignmentUsage;
export function createUsageAccumulator(startedAt?: number): {
  snapshot(): AssignmentUsage;
  observeMessageEnd(message: { usage?: unknown; model?: string }, timestamp?: number): void;
  observeToolEnd(timestamp?: number): void;
};
export function mergeAttemptUsages(attempts?: Array<{ usage?: AssignmentUsage }>): AssignmentUsage | undefined;
export function normalizeAssignmentUsage(raw: unknown): AssignmentUsage | undefined;
export function formatUsageSummary(usage: AssignmentUsage | undefined): string | undefined;
