export type Unlisten = () => void;

export interface ListenerGroup {
  add(registration: Promise<Unlisten>): Promise<void>;
  dispose(): void;
  isDisposed(): boolean;
}

export function createListenerGroup(): ListenerGroup {
  const active = new Set<Unlisten>();
  let disposed = false;

  return {
    async add(registration) {
      const unlisten = await registration;
      if (disposed) {
        unlisten();
        return;
      }
      active.add(unlisten);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unlisten of active) unlisten();
      active.clear();
    },
    isDisposed() {
      return disposed;
    },
  };
}
