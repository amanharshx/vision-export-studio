// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, mock, test } from "bun:test";
import { createListenerGroup, type Unlisten } from "./listener-group";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("createListenerGroup", () => {
  test("unlistens a handle that resolves after disposal", async () => {
    const registration = deferred<Unlisten>();
    const unlisten = mock(() => {});
    const group = createListenerGroup();
    const pending = group.add(registration.promise);

    group.dispose();
    registration.resolve(unlisten);
    await pending;

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  test("dispose is idempotent", async () => {
    const unlisten = mock(() => {});
    const group = createListenerGroup();
    await group.add(Promise.resolve(unlisten));

    group.dispose();
    group.dispose();

    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  test("Strict Mode remount leaves one active subscription set and one rendered line", async () => {
    const eventNames = ["stdout", "stderr", "finished", "failed", "cancelled"] as const;
    const callbacks = new Map(eventNames.map((name) => [name, new Set<(line: string) => void>()]));
    const renderedLines: string[] = [];
    const firstGroup = createListenerGroup();
    const firstRegistrations = eventNames.map((name) => ({
      name,
      callback: (line: string) => renderedLines.push(line),
      registration: deferred<Unlisten>(),
    }));
    const firstPending = Promise.all(
      firstRegistrations.map(({ registration }) => firstGroup.add(registration.promise)),
    );

    firstGroup.dispose();
    for (const { name, callback, registration } of firstRegistrations) {
      callbacks.get(name)?.add(callback);
      registration.resolve(() => {
        callbacks.get(name)?.delete(callback);
      });
    }
    await firstPending;

    const secondGroup = createListenerGroup();
    await Promise.all(eventNames.map((name) => {
      const callback = name === "stdout"
        ? (line: string) => renderedLines.push(line)
        : () => {};
      callbacks.get(name)?.add(callback);
      return secondGroup.add(Promise.resolve(() => {
        callbacks.get(name)?.delete(callback);
      }));
    }));

    for (const callback of callbacks.get("stdout") ?? []) callback("backend line");

    expect([...callbacks.values()].reduce((total, listeners) => total + listeners.size, 0)).toBe(5);
    expect(renderedLines).toEqual(["backend line"]);

    secondGroup.dispose();
    expect([...callbacks.values()].reduce((total, listeners) => total + listeners.size, 0)).toBe(0);
  });

  test("disposes every listener in an active install group once", async () => {
    const group = createListenerGroup();
    const unlisteners = Array.from({ length: 4 }, () => mock(() => {}));
    await Promise.all(unlisteners.map((unlisten) => group.add(Promise.resolve(unlisten))));

    group.dispose();
    group.dispose();

    for (const unlisten of unlisteners) {
      expect(unlisten).toHaveBeenCalledTimes(1);
    }
  });
});
