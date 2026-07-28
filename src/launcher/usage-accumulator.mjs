/** Pi message usage → bounded assignment usage totals (Phase 4). */

import { MAX_USAGE_MODEL_BYTES, MAX_USAGE_MODELS } from "./result-bounds.mjs";

export { MAX_USAGE_MODEL_BYTES, MAX_USAGE_MODELS };

const USAGE_NUMERIC_KEYS = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "totalTokens"];
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite", "total"];

function utf8Bytes(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function boundUtf8Text(text, maxBytes) {
  const source = String(text ?? "");
  if (utf8Bytes(source) <= maxBytes) return source;
  let end = source.length;
  while (end > 0 && utf8Bytes(source.slice(0, end)) > maxBytes) end -= 1;
  return source.slice(0, end);
}

function nonNegativeInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function exactKeys(input, allowed) {
  return Object.keys(input).every((key) => allowed.includes(key));
}

export function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    assistantCalls: 0,
    toolCalls: 0,
    models: [],
  };
}

function parseCost(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !exactKeys(raw, COST_KEYS)) return undefined;
  const cost = {};
  for (const key of COST_KEYS) {
    if (!nonNegativeNumber(raw[key])) return undefined;
    cost[key] = raw[key];
  }
  return cost;
}

/** Parse one Pi `message.usage` object without inferring missing cost totals. */
export function parsePiMessageUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const allowed = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost", "reasoning", "cacheWrite1h"];
  if (!Object.keys(raw).every((key) => allowed.includes(key))) return undefined;
  const cost = parseCost(raw.cost);
  if (!cost) return undefined;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
    if (!nonNegativeInteger(raw[key])) return undefined;
  }
  if (raw.reasoning !== undefined && !nonNegativeInteger(raw.reasoning)) return undefined;
  if (raw.cacheWrite1h !== undefined && !nonNegativeInteger(raw.cacheWrite1h)) return undefined;
  return {
    input: raw.input,
    output: raw.output,
    cacheRead: raw.cacheRead,
    cacheWrite: raw.cacheWrite,
    reasoning: raw.reasoning ?? 0,
    totalTokens: raw.totalTokens,
    cost,
  };
}

function addModels(target, model) {
  if (typeof model !== "string" || !model.trim()) return;
  const bounded = boundUtf8Text(model.trim(), MAX_USAGE_MODEL_BYTES);
  if (!bounded || target.includes(bounded)) return;
  if (target.length < MAX_USAGE_MODELS) target.push(bounded);
}

function mergeModels(left = [], right = []) {
  const merged = [...left];
  for (const model of right) addModels(merged, model);
  return merged;
}

/** Sum two normalized usage snapshots. */
export function accumulateUsage(base, delta) {
  if (!delta) return base;
  const next = emptyUsage();
  for (const key of USAGE_NUMERIC_KEYS) next[key] = (base[key] ?? 0) + (delta[key] ?? 0);
  for (const key of COST_KEYS) next.cost[key] = (base.cost?.[key] ?? 0) + (delta.cost?.[key] ?? 0);
  next.assistantCalls = (base.assistantCalls ?? 0) + (delta.assistantCalls ?? 0);
  next.toolCalls = (base.toolCalls ?? 0) + (delta.toolCalls ?? 0);
  next.models = mergeModels(base.models, delta.models);
  if (base.startedAt !== undefined || delta.startedAt !== undefined) {
    next.startedAt = Math.min(base.startedAt ?? delta.startedAt, delta.startedAt ?? base.startedAt);
  }
  if (base.endedAt !== undefined || delta.endedAt !== undefined) {
    next.endedAt = Math.max(base.endedAt ?? delta.endedAt, delta.endedAt ?? base.endedAt);
  }
  if (next.startedAt !== undefined && next.endedAt !== undefined) {
    next.durationMs = Math.max(0, next.endedAt - next.startedAt);
  }
  return next;
}

export function createUsageAccumulator(startedAt) {
  let usage = emptyUsage();
  if (typeof startedAt === "number" && Number.isFinite(startedAt)) usage.startedAt = startedAt;
  return {
    snapshot() {
      return structuredClone(usage);
    },
    observeMessageEnd(message, timestamp = Date.now()) {
      const parsed = parsePiMessageUsage(message?.usage);
      if (parsed) {
        usage = accumulateUsage(usage, { ...parsed, assistantCalls: 1, models: [] });
      } else {
        usage.assistantCalls += 1;
      }
      addModels(usage.models, message?.model);
      usage.endedAt = timestamp;
      if (usage.startedAt !== undefined) usage.durationMs = Math.max(0, timestamp - usage.startedAt);
    },
    observeToolEnd(timestamp = Date.now()) {
      usage.toolCalls += 1;
      usage.endedAt = timestamp;
      if (usage.startedAt !== undefined) usage.durationMs = Math.max(0, timestamp - usage.startedAt);
    },
  };
}

export function mergeAttemptUsages(attempts = []) {
  let merged = emptyUsage();
  for (const attempt of attempts) {
    if (!attempt?.usage) continue;
    merged = accumulateUsage(merged, attempt.usage);
  }
  if (merged.assistantCalls === 0 && merged.toolCalls === 0 && merged.totalTokens === 0 && merged.cost.total === 0 && merged.models.length === 0) {
    return undefined;
  }
  return merged;
}

const RESTORE_USAGE_KEYS = [...USAGE_NUMERIC_KEYS, "cost", "assistantCalls", "toolCalls", "startedAt", "endedAt", "durationMs", "models"];

/** Validate persisted assignment usage; reject unknown or out-of-range fields. */
export function normalizeAssignmentUsage(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !exactKeys(raw, RESTORE_USAGE_KEYS)) return undefined;
  for (const key of USAGE_NUMERIC_KEYS) {
    if (!nonNegativeInteger(raw[key])) return undefined;
  }
  if (!nonNegativeInteger(raw.assistantCalls) || !nonNegativeInteger(raw.toolCalls)) return undefined;
  const cost = parseCost(raw.cost);
  if (!cost) return undefined;
  if (!Array.isArray(raw.models) || raw.models.length > MAX_USAGE_MODELS) return undefined;
  const models = [];
  for (const model of raw.models) {
    if (typeof model !== "string" || utf8Bytes(model) === 0 || utf8Bytes(model) > MAX_USAGE_MODEL_BYTES) return undefined;
    addModels(models, model);
  }
  if (raw.startedAt !== undefined && !nonNegativeInteger(raw.startedAt)) return undefined;
  if (raw.endedAt !== undefined && !nonNegativeInteger(raw.endedAt)) return undefined;
  if (raw.durationMs !== undefined && !nonNegativeInteger(raw.durationMs)) return undefined;
  return {
    input: raw.input,
    output: raw.output,
    cacheRead: raw.cacheRead,
    cacheWrite: raw.cacheWrite,
    reasoning: raw.reasoning,
    totalTokens: raw.totalTokens,
    cost,
    assistantCalls: raw.assistantCalls,
    toolCalls: raw.toolCalls,
    ...(raw.startedAt === undefined ? {} : { startedAt: raw.startedAt }),
    ...(raw.endedAt === undefined ? {} : { endedAt: raw.endedAt }),
    ...(raw.durationMs === undefined ? {} : { durationMs: raw.durationMs }),
    models,
  };
}

export function formatUsageSummary(usage) {
  if (!usage) return undefined;
  const parts = [`${usage.totalTokens.toLocaleString("en-US")} tok`];
  if (usage.cost?.total > 0) parts.push(`$${usage.cost.total.toFixed(4)}`);
  if (usage.models.length > 0) parts.push(usage.models.join(", "));
  if (usage.assistantCalls > 0) parts.push(`${usage.assistantCalls} assistant`);
  if (usage.toolCalls > 0) parts.push(`${usage.toolCalls} tool`);
  return parts.join(" · ");
}
