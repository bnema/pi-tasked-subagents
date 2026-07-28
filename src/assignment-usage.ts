import { MAX_USAGE_MODEL_BYTES, MAX_USAGE_MODELS } from "./defaults.js";

export { MAX_USAGE_MODEL_BYTES, MAX_USAGE_MODELS };

export interface AssignmentUsageCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface AssignmentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  totalTokens: number;
  cost: AssignmentUsageCost;
  assistantCalls: number;
  toolCalls: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  models: string[];
}

export {
  accumulateUsage,
  createUsageAccumulator,
  emptyUsage,
  formatUsageSummary,
  mergeAttemptUsages,
  normalizeAssignmentUsage,
  parsePiMessageUsage,
} from "./launcher/usage-accumulator.mjs";
