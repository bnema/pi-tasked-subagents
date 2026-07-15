import { createHash } from "node:crypto";

function unsupported(value: unknown): never {
  throw new TypeError(`Unsupported value in canonical JSON: ${typeof value}`);
}

class BoundedCanonicalWriter {
  private readonly chunks: string[] = [];
  private byteLength = 0;

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new TypeError("Invalid canonical JSON byte limit");
  }

  append(value: string): void {
    const nextLength = this.byteLength + Buffer.byteLength(value, "utf8");
    if (nextLength > this.limit) throw new RangeError("Canonical JSON exceeds its byte limit");
    this.chunks.push(value);
    this.byteLength = nextLength;
  }

  toString(): string {
    return this.chunks.join("");
  }
}

function encodeString(value: string, writer: BoundedCanonicalWriter): void {
  writer.append('"');
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    switch (code) {
      case 0x22: writer.append('\\"'); continue;
      case 0x5c: writer.append("\\\\"); continue;
      case 0x08: writer.append("\\b"); continue;
      case 0x0c: writer.append("\\f"); continue;
      case 0x0a: writer.append("\\n"); continue;
      case 0x0d: writer.append("\\r"); continue;
      case 0x09: writer.append("\\t"); continue;
      default:
        if (code <= 0x1f || (code >= 0xd800 && code <= 0xdbff &&
          (index + 1 === value.length || value.charCodeAt(index + 1) < 0xdc00 || value.charCodeAt(index + 1) > 0xdfff)) ||
          (code >= 0xdc00 && code <= 0xdfff)) {
          writer.append(`\\u${code.toString(16).padStart(4, "0")}`);
        } else if (code >= 0xd800 && code <= 0xdbff) {
          writer.append(value.slice(index, index + 2));
          index += 1;
        } else {
          writer.append(value[index]);
        }
    }
  }
  writer.append('"');
}

function encode(value: unknown, seen: Set<object>, writer: BoundedCanonicalWriter): void {
  if (value === null) {
    writer.append("null");
    return;
  }
  switch (typeof value) {
    case "string":
      encodeString(value, writer);
      return;
    case "boolean":
    case "number":
      if (typeof value === "number" && !Number.isFinite(value)) return unsupported(value);
      writer.append(JSON.stringify(value));
      return;
    case "object":
      break;
    default:
      return unsupported(value);
  }

  if (seen.has(value)) throw new TypeError("Unsupported cyclic value in canonical JSON");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      writer.append("[");
      for (let index = 0; index < value.length; index += 1) {
        if (index > 0) writer.append(",");
        encode(value[index], seen, writer);
      }
      writer.append("]");
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return unsupported(value);
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    writer.append("{");
    for (let index = 0; index < keys.length; index += 1) {
      if (index > 0) writer.append(",");
      const key = keys[index];
      encodeString(key, writer);
      writer.append(":");
      encode(record[key], seen, writer);
    }
    writer.append("}");
  } finally {
    seen.delete(value);
  }
}

/** Serialize JSON-compatible data with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  return canonicalJsonBounded(value, Number.MAX_SAFE_INTEGER);
}

/**
 * Serialize JSON-compatible data canonically, stopping as soon as its UTF-8
 * output would exceed `maxBytes`. Accepted values are byte-for-byte identical
 * to canonicalJson.
 */
export function canonicalJsonBounded(value: unknown, maxBytes: number): string {
  const writer = new BoundedCanonicalWriter(maxBytes);
  encode(value, new Set<object>(), writer);
  return writer.toString();
}

/** Return the lowercase SHA-256 hex digest of bytes. */
export function sha256Hex(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Measure strings directly and other JSON-compatible values by canonical UTF-8 encoding. */
export function utf8Bytes(value: unknown): number {
  return Buffer.byteLength(typeof value === "string" ? value : canonicalJson(value), "utf8");
}
