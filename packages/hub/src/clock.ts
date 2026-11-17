export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>;

export const systemSleep: Sleep = (milliseconds, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, milliseconds));
    signal.addEventListener("abort", done, { once: true });
  });
