#!/usr/bin/env node

const usage = "Usage: npm run recover-session -- --input <session.jsonl> --output <recovered.jsonl> [--data-root <root>]";
const safeRecoveryErrors = new Set([
  "input and output must differ",
  "output already exists",
  "output path cannot be inspected",
  "input is not readable",
  "input is not a regular file",
  "output cannot be created",
  "invalid session header",
  "invalid JSONL record",
  "invalid v4 state entry",
  "v4 state entry cannot be recovered",
  "session recovery failed",
]);

function argumentError() {
  throw new Error(usage);
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name !== "--input" && name !== "--output" && name !== "--data-root") argumentError();
    const value = args[index + 1];
    if (!value || value.startsWith("--") || options[name]) argumentError();
    options[name] = value;
    index += 1;
  }
  if (!options["--input"] || !options["--output"]) argumentError();
  return { input: options["--input"], output: options["--output"], dataRoot: options["--data-root"] };
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : "session recovery failed";
  return safeRecoveryErrors.has(message) ? message : "session recovery failed";
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : usage}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    await import("./recover-session-loader.mjs");
    const { recoverSession } = await import("../src/recovery/recover-session.ts");
    const report = await recoverSession(options);
    process.stdout.write(`Recovered ${report.inputRecords} records (${report.convertedStateEntries} state entries); ${report.inputBytes} input bytes -> ${report.outputBytes} output bytes.\n`);
  } catch (error) {
    process.stderr.write(`Recovery failed: ${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}

await main();
