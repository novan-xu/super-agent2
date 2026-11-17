export interface Store<State> {
  getState(): State;
  update(change: (state: State) => State): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<State>(initial: State): Store<State> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    update: (change) => {
      const next = change(state);
      if (next !== state) {
        state = next;
        for (const listener of listeners) {
          listener();
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
