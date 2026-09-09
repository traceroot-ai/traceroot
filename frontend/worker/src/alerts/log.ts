const PREFIX = "[Alerts]";

export function logInfo(message: string): void {
  console.log(`${PREFIX} ${message}`);
}

export function logError(message: string, error?: unknown): void {
  if (error === undefined) {
    console.error(`${PREFIX} ${message}`);
    return;
  }
  console.error(`${PREFIX} ${message}`, error);
}
