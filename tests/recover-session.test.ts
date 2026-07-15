import { createHash } from "node:crypto";
import { link, mkdtemp, open as openFile, readFile, readdir, rm, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, describe, expect, test } from "vitest";

import { jsonlRecords, recoverSession } from "../src/recovery/recover-session.js";
import { syntheticState } from "./persistence-fixtures.js";

const execFileAsync = promisify(execFile);
const recoveryCli = resolve("scripts/recover-session.mjs");

async function runRecoveryCli(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(process.execPath, [recoveryCli, ...args]);
}

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pi-tasked-subagents-recovery-"));
  roots.push(value);
  return value;
}

function header(): Record<string, unknown> {
  return { type: "session", version: 3, id: "generic-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/generic" };
}

function stateEntry(id: string, parentId: string | null, position: number): Record<string, unknown> {
  return {
    type: "custom",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:01.000Z",
    position,
    customType: "pi-tasked-subagents:state",
    data: syntheticState(1),
  };
}

describe("offline session recovery", () => {
  test("streams v4 entries into pointers while retaining only one record and copying unrelated bytes", async () => {
    const directory = await root();
    const input = join(directory, "generic-session.jsonl");
    const output = join(directory, "recovered.jsonl");
    const unrelated = "{\"type\":\"label\",\"id\":\"label-1\",\"parentId\":\"state-1\",\"timestamp\":\"2026-01-01T00:00:02.000Z\",\"targetId\":\"state-1\",\"label\":\"generic\"}";
    const lines = [JSON.stringify(header()), JSON.stringify(stateEntry("state-1", null, 7)), unrelated];
    await writeFile(input, `${lines.join("\r\n")}\r\n`);
    const sourceHash = createHash("sha256").update(await readFile(input)).digest("hex");
    const retained: number[] = [];

    const report = await recoverSession({
      input,
      output,
      dataRoot: join(directory, "data"),
      onRecordProcessed: (count) => retained.push(count),
    });

    expect(retained).toHaveLength(lines.length);
    expect(Math.max(...retained)).toBe(1);
    expect(report).toEqual({ inputRecords: 3, convertedStateEntries: 1, copiedRecords: 1, inputBytes: (await stat(input)).size, outputBytes: (await stat(output)).size });
    expect(JSON.stringify(report)).not.toContain("generic-session.jsonl");
    expect(createHash("sha256").update(await readFile(input)).digest("hex")).toBe(sourceHash);

    const recovered = (await readFile(output, "utf8")).split("\r\n").filter(Boolean);
    expect(recovered).toHaveLength(3);
    expect(recovered[2]).toBe(unrelated);
    const entry = JSON.parse(recovered[1]) as Record<string, unknown>;
    expect(entry).toMatchObject({ id: "state-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", position: 7, customType: "pi-tasked-subagents:state" });
    expect(entry.data).toMatchObject({ version: 5, sequence: 1 });
  });

  test("preserves each input delimiter, including a final record without a newline, in the streaming pass", async () => {
    const directory = await root();
    const input = join(directory, "mixed-newlines.jsonl");
    const output = join(directory, "recovered.jsonl");
    const unrelated = "{\"type\":\"label\",\"id\":\"label-1\"}";
    await writeFile(input, `${JSON.stringify(header())}\r\n${JSON.stringify(stateEntry("state-1", null, 1))}\n${unrelated}`);

    await recoverSession({ input, output, dataRoot: join(directory, "data") });

    const recovered = await readFile(output, "utf8");
    expect(recovered.match(/\r\n|\n/g)).toEqual(["\r\n", "\n"]);
    expect(recovered.endsWith(unrelated)).toBe(true);
  });

  test("deduplicates equivalent migrated objects and removes incomplete output on invalid JSON without touching source", async () => {
    const directory = await root();
    const input = join(directory, "generic-session.jsonl");
    const output = join(directory, "recovered.jsonl");
    const duplicate = syntheticState(1);
    await writeFile(input, [JSON.stringify(header()), JSON.stringify({ ...stateEntry("state-1", null, 1), data: duplicate }), JSON.stringify({ ...stateEntry("state-2", "state-1", 2), data: duplicate })].join("\n"));
    const report = await recoverSession({ input, output, dataRoot: join(directory, "data") });
    expect(report).toMatchObject({ convertedStateEntries: 2 });
    expect((await readFile(output, "utf8")).match(/"checkpointId":"[a-f0-9]{64}"/g)).toHaveLength(2);
    // The two snapshots produce two manifests, but their terminal archive is one immutable object.
    expect(await readdir(join(directory, "data", "objects"))).toHaveLength(3);

    const invalid = join(directory, "invalid.jsonl");
    const failedOutput = join(directory, "failed.jsonl");
    await writeFile(invalid, `${JSON.stringify(header())}\n{not-json}\n`);
    const source = await readFile(invalid);
    await expect(recoverSession({ input: invalid, output: failedOutput, dataRoot: join(directory, "failed-data") })).rejects.toThrow("invalid JSONL record");
    expect(await readFile(invalid)).toEqual(source);
    await expect(stat(failedOutput)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("publishes only a fully synced and closed temporary file, then syncs its parent", async () => {
    const directory = await root();
    const input = join(directory, "source.jsonl");
    const output = join(directory, "recovered.jsonl");
    await writeFile(input, `${JSON.stringify(header())}\n`);
    let fileSynced = false;
    let fileClosed = false;
    let linked = false;
    let directorySyncs = 0;
    const outputDirectory = {
      path: (name: string) => join(directory, name),
      openFile: async (name: string, flags: number, mode?: number) => openFile(join(directory, name), flags, mode),
      link: async (name: string, destination: { path(name: string): string }, destinationName: string) => {
        expect(fileSynced).toBe(true);
        expect(fileClosed).toBe(true);
        linked = true;
        await link(join(directory, name), destination.path(destinationName));
      },
      sync: async () => { directorySyncs += 1; },
      unlink: async (name: string) => { await unlink(join(directory, name)); },
      close: async () => undefined,
    };

    await recoverSession({
      input,
      output,
      dataRoot: join(directory, "data"),
      openOutputDirectory: async () => outputDirectory as never,
      openOutput: async (path) => {
        const nativeHandle = await openFile(path, "wx", 0o600);
        return {
          writeFile: nativeHandle.writeFile.bind(nativeHandle),
          sync: async () => { await nativeHandle.sync(); fileSynced = true; },
          close: async () => { await nativeHandle.close(); fileClosed = true; },
        } as unknown as FileHandle;
      },
    });

    expect(linked).toBe(true);
    expect(directorySyncs).toBe(2);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  });

  test("does not replace an output created during conversion and removes its temporary sibling", async () => {
    const directory = await root();
    const input = join(directory, "source.jsonl");
    const output = join(directory, "recovered.jsonl");
    await writeFile(input, `${JSON.stringify(header())}\n`);

    await expect(recoverSession({
      input,
      output,
      dataRoot: join(directory, "data"),
      onRecordProcessed: async () => { await writeFile(output, "winner"); },
    })).rejects.toThrow("output already exists");

    expect(await readFile(output, "utf8")).toBe("winner");
    expect((await readdir(directory)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  test("surfaces a temporary cleanup error alongside a conversion error", async () => {
    const directory = await root();
    const input = join(directory, "invalid.jsonl");
    const output = join(directory, "recovered.jsonl");
    await writeFile(input, `${JSON.stringify(header())}\n{not-json}\n`);
    const outputDirectory = {
      path: (name: string) => join(directory, name),
      openFile: async (name: string, flags: number, mode?: number) => openFile(join(directory, name), flags, mode),
      link: async (name: string, destination: { path(name: string): string }, destinationName: string) => link(join(directory, name), destination.path(destinationName)),
      sync: async () => undefined,
      unlink: async () => { throw new Error("synthetic temporary cleanup rejection"); },
      close: async () => undefined,
    };

    const failure = await recoverSession({
      input,
      output,
      dataRoot: join(directory, "data"),
      openOutputDirectory: async () => outputDirectory as never,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("session recovery failed");
    expect((failure as Error & { cause?: AggregateError }).cause).toBeInstanceOf(AggregateError);
    expect((failure as Error & { cause: AggregateError }).cause.errors.map((error) => (error as Error).message)).toContain("synthetic temporary cleanup rejection");
  });

  test("removes incomplete output when an injected output FileHandle close rejects", async () => {
    const directory = await root();
    const input = join(directory, "source.jsonl");
    const output = join(directory, "failed.jsonl");
    await writeFile(input, `${JSON.stringify(header())}\n`);
    const source = await readFile(input);
    let nativeHandle: FileHandle | undefined;
    let closeAttempts = 0;

    try {
      await expect(recoverSession({
        input,
        output,
        dataRoot: join(directory, "data"),
        openOutput: async (path) => {
          nativeHandle = await openFile(path, "wx", 0o600);
          return {
            writeFile: nativeHandle.writeFile.bind(nativeHandle),
            sync: nativeHandle.sync.bind(nativeHandle),
            close: async () => {
              closeAttempts += 1;
              throw new Error("synthetic close rejection");
            },
          } as unknown as FileHandle;
        },
      })).rejects.toThrow("session recovery failed");
      expect(closeAttempts).toBe(1);
      expect(await readFile(input)).toEqual(source);
      await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await nativeHandle?.close();
    }
  });

  test("rejects malformed headers and refuses to overwrite input or an existing output", async () => {
    const directory = await root();
    const input = join(directory, "generic-session.jsonl");
    await writeFile(input, `${JSON.stringify({ type: "session", id: 5 })}\n`);
    const malformedOutput = join(directory, "malformed-header.jsonl");
    await expect(recoverSession({ input, output: malformedOutput, dataRoot: join(directory, "data") })).rejects.toThrow("invalid session header");
    await expect(stat(malformedOutput)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(recoverSession({ input, output: input, dataRoot: join(directory, "data") })).rejects.toThrow("input and output must differ");
    const output = join(directory, "existing.jsonl");
    await writeFile(output, "existing");
    await expect(recoverSession({ input, output, dataRoot: join(directory, "data") })).rejects.toThrow("output already exists");
  });
});

describe("JSONL record bounds", () => {
  async function collectRecords(chunks: readonly Buffer[], maxRecordBytes: number): Promise<void> {
    async function* source(): AsyncGenerator<Buffer> {
      yield* chunks;
    }
    for await (const _record of jsonlRecords(source(), maxRecordBytes)) {
      // Consume records so generator errors are surfaced.
    }
  }

  test("rejects oversized newline-terminated records spanning chunks before concatenating or decoding", async () => {
    await expect(collectRecords([Buffer.from("1234"), Buffer.from("56789\n")], 8)).rejects.toThrow("JSONL record exceeds the 8 byte recovery limit");
  });

  test("rejects oversized final unterminated records spanning chunks before concatenating or decoding", async () => {
    await expect(collectRecords([Buffer.from("1234"), Buffer.from("56789")], 8)).rejects.toThrow("JSONL record exceeds the 8 byte recovery limit");
  });
});

describe("recover-session CLI", () => {
  test("requires input and output arguments and rejects same input/output without creating a file", async () => {
    await expect(runRecoveryCli()).rejects.toMatchObject({ code: 1, stderr: expect.stringMatching(/Usage:/) });

    const directory = await root();
    const input = join(directory, "generic-session.jsonl");
    await writeFile(input, `${JSON.stringify(header())}\n`);
    await expect(runRecoveryCli("--input", input, "--output", input)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/input and output must differ/),
    });
    expect(await readFile(input, "utf8")).toBe(`${JSON.stringify(header())}\n`);
  });

  test("refuses existing output, injects data root, and reports only concise non-sensitive counts", async () => {
    const directory = await root();
    const input = join(directory, "source.jsonl");
    const output = join(directory, "recovered.jsonl");
    const dataRoot = join(directory, "injected-data");
    const sensitive = "private-record-content /private/embedded/path";
    await writeFile(input, `${JSON.stringify(header())}\n${JSON.stringify({ ...stateEntry("state-1", null, 1), data: syntheticState(1), note: sensitive })}\n`);

    const success = await runRecoveryCli("--input", input, "--output", output, "--data-root", dataRoot);
    expect(success.stderr).toBe("");
    expect(success.stdout).toMatch(/^Recovered 2 records \(1 state entries\); \d+ input bytes -> \d+ output bytes\.\n$/);
    expect(`${success.stdout}${success.stderr}`).not.toContain(sensitive);
    expect(`${success.stdout}${success.stderr}`).not.toContain("/private/embedded/path");
    expect(await stat(join(dataRoot, "objects"))).toBeDefined();

    await expect(runRecoveryCli("--input", input, "--output", output)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/output already exists/),
    });
  });

  test("returns a non-zero exit without leaking record contents and cleans incomplete output", async () => {
    const directory = await root();
    const input = join(directory, "invalid.jsonl");
    const output = join(directory, "failed.jsonl");
    const sensitive = "private-record-content /private/embedded/path";
    await writeFile(input, `${JSON.stringify(header())}\n{${sensitive}}\n`);

    await expect(runRecoveryCli("--input", input, "--output", output)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/Recovery failed: invalid JSONL record/),
    });
    await expect(stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("ships the recovery script in npm pack", async () => {
    const { stdout } = await execFileAsync("npm", ["pack", "--dry-run", "--json"]);
    const packed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    expect(packed[0]?.files.map((file) => file.path)).toContain("scripts/recover-session.mjs");
  });
});
