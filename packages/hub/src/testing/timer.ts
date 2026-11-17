import type { Sleep } from "../clock.js";
import type { TestClock } from "./access.js";

export function settledTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

interface Sleeper {
  readonly due: number;
  readonly wake: () => void;
}

export class ManualTimer {
  private readonly sleepers = new Set<Sleeper>();
  private readonly watchers = new Set<() => void>();

  constructor(private readonly clock: TestClock) {}

  readonly sleep: Sleep = (milliseconds, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const sleeper: Sleeper = {
        due: this.clock.now() + Math.max(0, milliseconds),
        wake: () => {
          this.sleepers.delete(sleeper);
          signal.removeEventListener("abort", sleeper.wake);
          resolve();
        },
      };
      this.sleepers.add(sleeper);
      signal.addEventListener("abort", sleeper.wake, { once: true });
      for (const watcher of [...this.watchers]) {
        watcher();
      }
    });

  get sleeping(): number {
    return this.sleepers.size;
  }

  asleep(): Promise<void> {
    return new Promise((resolve) => {
      if (this.sleepers.size > 0) {
        resolve();
        return;
      }
      const watcher = () => {
        this.watchers.delete(watcher);
        resolve();
      };
      this.watchers.add(watcher);
    });
  }

  async next(): Promise<void> {
    await this.asleep();
    await settledTurn();
    await this.asleep();
    const earliest = [...this.sleepers].sort((a, b) => a.due - b.due)[0];
    if (earliest === undefined) {
      return;
    }
    if (earliest.due > this.clock.now()) {
      this.clock.advance(earliest.due - this.clock.now());
    }
    for (const sleeper of [...this.sleepers]) {
      if (sleeper.due <= this.clock.now()) {
        sleeper.wake();
      }
    }
  }
}
