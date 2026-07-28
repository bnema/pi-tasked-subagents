function extractBalancedJsonObjectCandidates(text) {
  const candidates = [];
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
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
      if (depth === 0) {
        candidates.push(text.slice(start, index + 1).trim());
        break;
      }
    }
  }
  return candidates;
}

function isTaskReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return typeof value.taskRunId === "string"
    && (value.groupId === undefined || typeof value.groupId === "string")
    && typeof value.taskId === "string"
    && typeof value.assignmentId === "string"
    && (value.status === "completed" || value.status === "attention" || value.status === "failed")
    && typeof value.summary === "string"
    && Array.isArray(value.criteriaEvidence);
}

export function parseTaskReportOutput(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return undefined;
  const fencedCandidates = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gu)].map((match) => match[1]);
  const candidates = [trimmed, ...fencedCandidates, ...extractBalancedJsonObjectCandidates(trimmed)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (isTaskReport(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}
