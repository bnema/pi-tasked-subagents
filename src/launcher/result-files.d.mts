export interface ResultIdentity {
  sessionId: string;
  runId: string;
  resultId: string;
}

export interface ResultFileOptions {
  root?: string;
  procDirectoryPath?: (fd: number) => string;
  beforeMutation?: (operation: "reserve-result" | "publish-terminal-result") => Promise<void> | void;
  resultPath?: string;
}

export interface PublishedTerminalResult {
  published: boolean;
  value: Record<string, unknown>;
}

export function verifyResultReservation(reservationPath: string, expected: ResultIdentity, options?: ResultFileOptions): Promise<ResultIdentity>;
export function reserveResultReservation(root: string, resultsDir: string, expected: ResultIdentity, options?: ResultFileOptions): Promise<{ resultPath: string; resultReservationPath: string }>;
export function releaseResultReservation(root: string, resultsDir: string, expected: ResultIdentity, options?: ResultFileOptions): Promise<void>;
export function publishTerminalResult(
  resultPath: string,
  reservationPath: string,
  expected: ResultIdentity,
  value: Record<string, unknown>,
  options?: ResultFileOptions,
): Promise<PublishedTerminalResult>;
