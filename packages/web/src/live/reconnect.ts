const steps = [500, 1000, 2000, 4000, 8000] as const;

export function reconnectDelay(attempt: number): number {
  return steps[Math.min(Math.max(attempt, 0), steps.length - 1)] ?? 8000;
}
