// ──────────────────────────────────────────────
// Identifier helpers for orchestration inputs
// ──────────────────────────────────────────────

export function normalizeTargetId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
