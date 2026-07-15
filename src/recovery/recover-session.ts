import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { migrateV4State } from "../state/v4-migration.js";
import { DurableObjectStore } from "../state/object-store.js";
import { stateFromEntryData } from "../state/persistence.js";
import { resolveStorageRoot, sessionStoragePaths } from "../state/storage-paths.js";

export interface RecoverSessionOptions {
  input: string;
  output: string;
  dataRoot?: string;
  /** Test/monitoring hook; recovery itself retains exactly one JSONL record. */
  onRecordProcessed?: (recordsRetained: number) => void;
  /** Test hook for simulating output-handle failures. */
  openOutput?: (path: string) => Promise<fs.FileHandle>;
}

/** Counts and byte totals only: this report deliberately contains no session content or paths. */
export interface RecoveryReport {
  inputRecords: number;
  convertedStateEntries: number;
  copiedRecords: number;
  inputBytes: number;
  outputBytes: number;
}

class RecoveryError extends Error {}

function fail(message: string): never {
  throw new RecoveryError(message);
}

function recoveryFailure(error: unknown): RecoveryError {
  return error instanceof RecoveryError ? error : new RecoveryError("session recovery failed", { cause: error });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function validHeader(value: unknown): value is { type: "session"; id: string; timestamp: string; cwd: string } {
  const header = record(value);
  return header?.type === "session" && typeof header.id === "string" && header.id.length > 0 &&
    typeof header.timestamp === "string" && typeof header.cwd === "string";
}

async function existingOutput(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new RecoveryError("output path cannot be inspected");
  }
}

/**
 * Yield one JSONL record at a time while retaining its original delimiter. Chunks
 * are accumulated only until their next LF, so no full input prepass or buffer is needed.
 */
async function* jsonlRecords(source: AsyncIterable<Buffer>): AsyncGenerator<{ line: string; delimiter?: "\n" | "\r\n" }> {
  let pending: Buffer[] = [];

  for await (const chunk of source) {
    let start = 0;
    let newline = chunk.indexOf(10, start);
    while (newline !== -1) {
      const parts = pending.length === 0 ? [chunk.subarray(start, newline)] : [...pending, chunk.subarray(start, newline)];
      const rawLine = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
      const crlf = rawLine.at(-1) === 13;
      yield {
        line: rawLine.subarray(0, crlf ? -1 : undefined).toString("utf8"),
        delimiter: crlf ? "\r\n" : "\n",
      };
      pending = [];
      start = newline + 1;
      newline = chunk.indexOf(10, start);
    }
    if (start < chunk.length) pending.push(chunk.subarray(start));
  }

  if (pending.length > 0) {
    const rawLine = pending.length === 1 ? pending[0]! : Buffer.concat(pending);
    yield { line: rawLine.toString("utf8") };
  }
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return fail("invalid JSONL record");
  }
}

function isV4StateEntry(entry: Record<string, unknown>): boolean {
  if (entry.type !== "custom" || entry.customType !== "pi-tasked-subagents:state") return false;
  const data = typeof entry.data === "string" ? parseLine(entry.data) : entry.data;
  return record(data)?.version === 4;
}

/**
 * Convert a session without loading its JSONL history. Each iteration owns one
 * parsed record and its delimiter; object writes use the bounded v4 migration.
 */
export async function recoverSession(options: RecoverSessionOptions): Promise<RecoveryReport> {
  const input = resolve(options.input);
  const output = resolve(options.output);
  if (input === output) fail("input and output must differ");
  if (await existingOutput(output)) fail("output already exists");

  let inputBytes: number;
  try {
    const inputStat = await fs.stat(input);
    if (!inputStat.isFile()) fail("input is not a regular file");
    inputBytes = inputStat.size;
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    fail("input is not readable");
  }

  let outputHandle: fs.FileHandle | undefined;
  let createdOutput = false;
  let failure: unknown;
  let failed = false;
  let report: RecoveryReport | undefined;

  try {
    await fs.mkdir(dirname(output), { recursive: true });
    try {
      outputHandle = options.openOutput ? await options.openOutput(output) : await fs.open(output, "wx", 0o600);
      createdOutput = true;
    } catch {
      fail("output cannot be created");
    }

    const store = new DurableObjectStore(resolveStorageRoot({ dataRoot: options.dataRoot }));
    let sessionId: string | undefined;
    let sequence = 1;
    let inputRecords = 0;
    let convertedStateEntries = 0;
    let copiedRecords = 0;
    let first = true;
    const source = createReadStream(input);

    try {
      for await (const { line, delimiter } of jsonlRecords(source)) {
        inputRecords += 1;
        try {
          const parsed = parseLine(line);
          if (first) {
            first = false;
            if (!validHeader(parsed)) fail("invalid session header");
            // Validate the ID before any durable object write.
            sessionStoragePaths(store.root, parsed.id);
            sessionId = parsed.id;
            await outputHandle.writeFile(line, "utf8");
            if (delimiter) await outputHandle.writeFile(delimiter, "utf8");
            continue;
          }

          const entry = record(parsed);
          if (!entry) fail("invalid JSONL record");
          if (isV4StateEntry(entry)) {
            const state = stateFromEntryData(entry.data);
            if (state.version !== 4 || !sessionId) fail("invalid v4 state entry");
            const migrated = await migrateV4State(state, store, {
              sessionId,
              sequence,
              appendMigratedPointer: () => undefined,
            });
            if (!migrated.migrated) fail("v4 state entry cannot be recovered");
            sequence += 1;
            entry.data = migrated.pointer;
            await outputHandle.writeFile(JSON.stringify(entry), "utf8");
            convertedStateEntries += 1;
          } else {
            await outputHandle.writeFile(line, "utf8");
            copiedRecords += 1;
          }
          if (delimiter) await outputHandle.writeFile(delimiter, "utf8");
        } finally {
          options.onRecordProcessed?.(1);
        }
      }
    } finally {
      source.destroy();
    }
    if (first) fail("invalid session header");
    await outputHandle.sync();
    report = {
      inputRecords,
      convertedStateEntries,
      copiedRecords,
      inputBytes,
      outputBytes: (await fs.stat(output)).size,
    };
  } catch (error) {
    failure = error;
    failed = true;
  } finally {
    try {
      if (outputHandle) await outputHandle.close();
    } catch (error) {
      // A conversion error is more actionable than a cleanup failure; otherwise retain close causality.
      if (!failed) {
        failure = error;
        failed = true;
      }
    } finally {
      if (createdOutput && failed) {
        try {
          await fs.rm(output, { force: true });
        } catch (error) {
          if (!failed) {
            failure = error;
            failed = true;
          }
        }
      }
    }
  }

  if (failed) throw recoveryFailure(failure);
  return report!;
}
