import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { MAX_RECOVERY_RECORD_BYTES } from "../defaults.js";
import { migrateV4State } from "../state/v4-migration.js";
import { DurableObjectStore } from "../state/object-store.js";
import { stateFromEntryData } from "../state/persistence.js";
import { pinDirectory, safeBasename, type PinnedDirectory } from "../state/pinned-directory.mjs";
import { resolveStorageRoot, sessionStoragePaths } from "../state/storage-paths.js";

export interface RecoverSessionOptions {
  input: string;
  output: string;
  dataRoot?: string;
  /** Test/monitoring hook; recovery itself retains exactly one JSONL record. */
  onRecordProcessed?: (recordsRetained: number) => unknown;
  /** Test hook for simulating temporary output-handle failures. */
  openOutput?: (path: string) => Promise<fs.FileHandle>;
  /** Test hook for simulating publication-directory failures. */
  openOutputDirectory?: (path: string) => Promise<PinnedDirectory>;
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

function retainFailure(primary: unknown | undefined, cleanup: unknown): unknown {
  return primary === undefined ? cleanup : new AggregateError([primary, cleanup], "session recovery failed");
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
 * Yield one JSONL record at a time while retaining its original delimiter. A
 * record is capped before retaining a chunk, concatenating buffers, or decoding UTF-8.
 */
export async function* jsonlRecords(
  source: AsyncIterable<Buffer>,
  maxRecordBytes = MAX_RECOVERY_RECORD_BYTES,
): AsyncGenerator<{ line: string; delimiter?: "\n" | "\r\n" }> {
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes <= 0) fail("invalid JSONL recovery record limit");
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const checkSize = (bytes: number): void => {
    if (bytes > maxRecordBytes) fail(`JSONL record exceeds the ${maxRecordBytes} byte recovery limit`);
  };

  for await (const chunk of source) {
    let start = 0;
    let newline = chunk.indexOf(10, start);
    while (newline !== -1) {
      const rawBytes = pendingBytes + newline - start;
      checkSize(rawBytes);
      const parts = pending.length === 0 ? [chunk.subarray(start, newline)] : [...pending, chunk.subarray(start, newline)];
      const rawLine = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
      const crlf = rawLine.at(-1) === 13;
      yield {
        line: rawLine.subarray(0, crlf ? -1 : undefined).toString("utf8"),
        delimiter: crlf ? "\r\n" : "\n",
      };
      pending = [];
      pendingBytes = 0;
      start = newline + 1;
      newline = chunk.indexOf(10, start);
    }
    if (start < chunk.length) {
      const remainder = chunk.subarray(start);
      checkSize(pendingBytes + remainder.length);
      pending.push(remainder);
      pendingBytes += remainder.length;
    }
  }

  if (pending.length > 0) {
    checkSize(pendingBytes);
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

  const outputDirectoryPath = dirname(output);
  const outputName = safeBasename(basename(output));
  const temporaryName = safeBasename(`.${outputName}.${process.pid}.${randomUUID()}.tmp`);
  let outputDirectory: PinnedDirectory | undefined;
  let outputHandle: fs.FileHandle | undefined;
  let temporaryExists = false;
  let failure: unknown;
  let report: RecoveryReport | undefined;

  try {
    await fs.mkdir(outputDirectoryPath, { recursive: true });
    outputDirectory = options.openOutputDirectory
      ? await options.openOutputDirectory(outputDirectoryPath)
      : await pinDirectory(outputDirectoryPath);
    try {
      outputHandle = options.openOutput
        ? await options.openOutput(outputDirectory.path(temporaryName))
        : await outputDirectory.openFile(temporaryName, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporaryExists = true;
    } catch {
      fail("output cannot be created");
    }

    const store = new DurableObjectStore(resolveStorageRoot({ dataRoot: options.dataRoot }));
    let sessionId: string | undefined;
    let sequence = 1;
    let inputRecords = 0;
    let convertedStateEntries = 0;
    let copiedRecords = 0;
    let outputBytes = 0;
    let first = true;
    const source = createReadStream(input);
    const writeOutput = async (value: string): Promise<void> => {
      await outputHandle!.writeFile(value, "utf8");
      outputBytes += Buffer.byteLength(value);
    };

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
            await writeOutput(line);
            if (delimiter) await writeOutput(delimiter);
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
            await writeOutput(JSON.stringify(entry));
            convertedStateEntries += 1;
          } else {
            await writeOutput(line);
            copiedRecords += 1;
          }
          if (delimiter) await writeOutput(delimiter);
        } finally {
          await options.onRecordProcessed?.(1);
        }
      }
    } finally {
      source.destroy();
    }
    if (first) fail("invalid session header");
    await outputHandle.sync();
    const completedOutputHandle = outputHandle;
    outputHandle = undefined;
    await completedOutputHandle.close();

    try {
      // link(2) is the atomic no-replace publication gate for sibling files.
      await outputDirectory.link(temporaryName, outputDirectory, outputName);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("output already exists");
      throw error;
    }
    await outputDirectory.sync();
    await outputDirectory.unlink(temporaryName);
    temporaryExists = false;
    // Persist both the final link and removal of the private staging name.
    await outputDirectory.sync();
    report = { inputRecords, convertedStateEntries, copiedRecords, inputBytes, outputBytes };
  } catch (error) {
    failure = error;
  } finally {
    if (outputHandle) {
      try {
        await outputHandle.close();
      } catch (error) {
        failure = retainFailure(failure, error);
      }
    }
    if (temporaryExists && outputDirectory) {
      try {
        await outputDirectory.unlink(temporaryName);
      } catch (error) {
        failure = retainFailure(failure, error);
      }
    }
    if (outputDirectory) {
      try {
        await outputDirectory.close();
      } catch (error) {
        failure = retainFailure(failure, error);
      }
    }
  }

  if (failure !== undefined) throw recoveryFailure(failure);
  return report!;
}
