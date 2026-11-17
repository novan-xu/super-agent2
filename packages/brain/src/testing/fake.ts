import type { Provider } from "@super-agent2/protocol";
import type { OpenOptions, ProgramAdapter, ProgramEvent, ProgramHandle, ProgramListener, SteerResult } from "@super-agent2/programs";

export class FakeHandle implements ProgramHandle {
  readonly prompts: string[] = [];
  readonly steers: string[] = [];
  interrupts = 0;
  closed = false;
  running = false;

  constructor(
    readonly program: FakeProgram,
    readonly options: OpenOptions,
    private readonly listener: ProgramListener,
  ) {}

  start(prompt: string): void {
    if (this.program.refuseStart !== undefined) {
      throw new Error(this.program.refuseStart);
    }
    this.prompts.push(prompt);
    this.running = true;
    this.program.notify({ kind: "start", handle: this, text: prompt });
  }

  steer(text: string): Promise<SteerResult> {
    if (!this.program.steering || !this.running) {
      return Promise.resolve("queued");
    }
    this.steers.push(text);
    this.program.notify({ kind: "steer", handle: this, text });
    return Promise.resolve("steered");
  }

  interrupt(): void {
    this.interrupts += 1;
    this.program.notify({ kind: "interrupt", handle: this, text: "" });
  }

  close(): Promise<void> {
    this.closed = true;
    this.running = false;
    return Promise.resolve();
  }

  emit(event: ProgramEvent): void {
    if (event.type === "turn.finished" || event.type === "failed" || event.type === "unavailable") {
      this.running = false;
    }
    this.listener(event);
  }

  finish(text?: string): void {
    if (text !== undefined) {
      this.emit({ type: "text", block: `reply-${this.prompts.length}`, delta: text });
    }
    this.emit({ type: "turn.finished", outcome: "completed" });
  }
}

export interface FakeHappening {
  readonly kind: "start" | "steer" | "interrupt";
  readonly handle: FakeHandle;
  readonly text: string;
}

export class FakeProgram implements ProgramAdapter {
  readonly handles: FakeHandle[] = [];
  readonly happenings: FakeHappening[] = [];
  steering = true;
  refuseStart: string | undefined;
  private waiters: { readonly kind: FakeHappening["kind"]; readonly resolve: (happening: FakeHappening) => void }[] = [];
  private readonly consumed = new Set<number>();

  constructor(
    readonly provider: Provider,
    readonly model: string = `${provider}-model`,
    readonly effort: string = "high",
  ) {}

  open(options: OpenOptions, listener: ProgramListener): FakeHandle {
    const handle = new FakeHandle(this, options, listener);
    this.handles.push(handle);
    return handle;
  }

  notify(happening: FakeHappening): void {
    this.happenings.push(happening);
    this.flush();
  }

  next(kind: FakeHappening["kind"] = "start"): Promise<FakeHappening> {
    return new Promise((resolve) => {
      this.waiters.push({ kind, resolve });
      this.flush();
    });
  }

  private flush(): void {
    this.waiters = this.waiters.filter((waiter) => {
      const index = this.happenings.findIndex((happening, position) => happening.kind === waiter.kind && !this.consumed.has(position));
      const happening = this.happenings[index];
      if (happening === undefined) {
        return true;
      }
      this.consumed.add(index);
      waiter.resolve(happening);
      return false;
    });
  }
}
