export interface ResultIdentity {
  sessionId: string;
  runId: string;
  resultId: string;
}

export interface PublishedTerminalResult {
  published: boolean;
  value: Record<string, unknown>;
}

export function verifyResultReservation(reservationPath: string, expected: ResultIdentity): Promise<ResultIdentity>;
export function publishTerminalResult(
  resultPath: string,
  reservationPath: string,
  expected: ResultIdentity,
  value: Record<string, unknown>,
): Promise<PublishedTerminalResult>;
