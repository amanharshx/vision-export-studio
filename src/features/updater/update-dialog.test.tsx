// @ts-expect-error Bun provides this module at test runtime.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

try {
  GlobalRegistrator.register();
} catch {
  // Already registered by another suite in the same bun test process.
}

import React, { useEffect, useState } from "react";
import { act } from "react";
import { useUpdaterController } from "./use-updater-controller";

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

let checkCalls = 0;
let checkImpl: () => Promise<unknown> = async () => null;
let relaunchCalls = 0;
let relaunchImpl: () => Promise<void> = async () => {};
let downloadCalls = 0;

function resetUpdaterFakes() {
  checkCalls = 0;
  relaunchCalls = 0;
  downloadCalls = 0;
  checkImpl = async () => null;
  relaunchImpl = async () => {};
  // Re-assert this suite's plugin fakes before every test: Bun shares
  // module mocks across files in one process, so another suite's fake must
  // never leak in here (and vice versa).
  mock.module("@tauri-apps/plugin-updater", () => ({
    check: () => {
      checkCalls += 1;
      return checkImpl();
    },
  }));
  mock.module("@tauri-apps/plugin-process", () => ({
    relaunch: () => {
      relaunchCalls += 1;
      return relaunchImpl();
    },
  }));
}

type OverlayMockProps = {
  open?: boolean;
  children?: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
  showCloseButton?: boolean;
  [key: string]: unknown;
};

function mockOverlayModules() {
  const passthrough = ({ children }: OverlayMockProps) => <>{children}</>;
  const root = ({ open, children }: OverlayMockProps) => (open ? <>{children}</> : null);
  const content = (props: OverlayMockProps) => {
    const { children, showCloseButton, onEscapeKeyDown, onPointerDownOutside, onInteractOutside } =
      props;
    const [blockedCount, setBlockedCount] = useState<number | null>(null);
    return (
      <div role="dialog">
        {children}
        {showCloseButton ? (
          <button type="button" aria-label="Close">
            Close
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Simulate dismiss"
          onClick={() => {
            let prevented = 0;
            const event = {
              preventDefault: () => {
                prevented += 1;
              },
            };
            (
              onEscapeKeyDown as ((event: { preventDefault(): void }) => void) | undefined
            )?.(event);
            (
              onPointerDownOutside as ((event: { preventDefault(): void }) => void) | undefined
            )?.(event);
            (
              onInteractOutside as ((event: { preventDefault(): void }) => void) | undefined
            )?.(event);
            setBlockedCount(prevented);
          }}
        >
          Simulate dismiss
        </button>
        {blockedCount === null ? null : (
          <span data-testid="dismiss-blocked">{blockedCount}</span>
        )}
      </div>
    );
  };
  const overlay = () => null;
  const title = ({ children }: OverlayMockProps) => <h2>{children}</h2>;
  const description = ({ children }: OverlayMockProps) => <p>{children}</p>;
  const section = ({ children }: OverlayMockProps) => <div>{children}</div>;
  return { passthrough, root, content, overlay, title, description, section };
}

mock.module("@/components/ui/dialog", () => {
  const { passthrough, root, content, overlay, title, description, section } = mockOverlayModules();
  return {
    Dialog: root,
    DialogTrigger: passthrough,
    DialogClose: passthrough,
    DialogPortal: passthrough,
    DialogOverlay: overlay,
    DialogContent: content,
    DialogHeader: section,
    DialogFooter: section,
    DialogTitle: title,
    DialogDescription: description,
  };
});

mock.module("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => {
    checkCalls += 1;
    return checkImpl();
  },
}));

mock.module("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => {
    relaunchCalls += 1;
    return relaunchImpl();
  },
}));

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { UpdateDialog } = await import("./update-dialog");
const { UpdateChecker } = await import("@/components/update-checker");

function makeFakeUpdate(opts: {
  version?: string;
  date?: string;
  body?: string;
  downloadImpl?: (onEvent: (e: DownloadEvent) => void) => Promise<void>;
}) {
  return {
    version: opts.version ?? "1.2.0",
    date: opts.date,
    body: opts.body,
    currentVersion: "0.1.13",
    downloadAndInstall: (onEvent?: (e: DownloadEvent) => void) => {
      downloadCalls += 1;
      if (opts.downloadImpl) return opts.downloadImpl(onEvent ?? (() => {}));
      return Promise.resolve();
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openAvailableDialog() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^updates$/i }));
  });
  await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("available"));
}

function Harness({ silentOnMount = false }: { silentOnMount?: boolean }) {
  const updater = useUpdaterController();
  useEffect(() => {
    if (silentOnMount) void updater.checkForUpdates({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [silentOnMount]);
  return (
    <div>
      <UpdateChecker updater={updater} />
      <UpdateDialog open={updater.dialogOpen} updater={updater} onOpenChange={updater.setDialogOpen} />
      <button type="button" aria-label="Attempt close" onClick={() => updater.setDialogOpen(false)}>
        Attempt close
      </button>
      <div data-testid="updater-state">{updater.state}</div>
      <div data-testid="dialog-open">{updater.dialogOpen ? "open" : "closed"}</div>
    </div>
  );
}

async function simulateDismiss() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Simulate dismiss" }));
  });
  return screen.getByTestId("dismiss-blocked").textContent;
}

describe("user-invoked update dialog", () => {
  beforeEach(() => {
    cleanup();
    resetUpdaterFakes();
  });

  test("startup stays silent, then a manual click opens checking with a fresh check", async () => {
    const manualGate = deferred<unknown>();
    let calls = 0;
    checkImpl = () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(makeFakeUpdate({ version: "9.9.9", body: "notes" }))
        : manualGate.promise;
    };
    render(<Harness silentOnMount />);
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("available"));
    expect(calls).toBe(1);
    expect(screen.getByTestId("dialog-open").textContent).toBe("closed");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: /update to 9\.9\.9/i })).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /update to 9\.9\.9/i }));
    });
    expect(calls).toBe(2);
    expect(screen.getByTestId("dialog-open").textContent).toBe("open");
    expect(screen.getByRole("dialog").textContent).toMatch(/checking for updates/i);
    await act(async () => {
      manualGate.resolve(null);
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("up-to-date"));
  });

  test("available shows metadata, invalid metadata omits the date, Not now closes quietly", async () => {
    const body = "Line one\nLine two\n- item";
    checkImpl = async () =>
      makeFakeUpdate({ version: "2.4.6", date: "2026-03-14T12:00:00.000Z", body });
    render(<Harness />);
    await openAvailableDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("2.4.6");
    expect(dialog.textContent).toContain("2026");
    expect(dialog.textContent).toContain("Line one");
    expect(dialog.textContent).toContain("Line two");
    const notes = screen.getByLabelText(/release notes/i);
    expect(notes.textContent).toBe(body);
    expect(notes.className).toMatch(/whitespace-pre-wrap/);
    expect(downloadCalls).toBe(0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(downloadCalls).toBe(0);
    expect(relaunchCalls).toBe(0);

    cleanup();
    resetUpdaterFakes();
    checkImpl = async () => makeFakeUpdate({ version: "3.0.0", date: "not-a-date", body: "" });
    render(<Harness />);
    await openAvailableDialog();
    expect(screen.getByRole("dialog").textContent).toContain("3.0.0");
    expect(screen.getByRole("dialog").textContent).not.toMatch(/released/i);
    expect(screen.queryByLabelText(/release notes/i)).toBeNull();
  });

  test("install starts on click, shows percent progress, then relaunches", async () => {
    checkImpl = async () =>
      makeFakeUpdate({
        version: "1.2.0",
        body: "notes",
        downloadImpl: async (onEvent) => {
          onEvent({ event: "Started", data: { contentLength: 1000 } });
          onEvent({ event: "Progress", data: { chunkLength: 250 } });
          onEvent({ event: "Progress", data: { chunkLength: 250 } });
        },
      });
    render(<Harness />);
    await openAvailableDialog();
    expect(downloadCalls).toBe(0);
    expect(relaunchCalls).toBe(0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));
    });
    await waitFor(() => expect(screen.getByText(/downloading… 50%/i)).not.toBeNull());
    expect(screen.getByRole("dialog").textContent).toMatch(/downloading and installing/i);
    await waitFor(() => expect(relaunchCalls).toBe(1));
    expect(downloadCalls).toBe(1);
  });

  test("unknown size is indeterminate; installing blocks dismiss and duplicate installs", async () => {
    const downloadGate = deferred<void>();
    checkImpl = async () =>
      makeFakeUpdate({
        version: "1.2.0",
        body: "notes",
        downloadImpl: async (onEvent) => {
          onEvent({ event: "Started", data: {} });
          onEvent({ event: "Progress", data: { chunkLength: 123 } });
          await downloadGate.promise;
        },
      });
    render(<Harness />);
    await openAvailableDialog();
    const install = screen.getByRole("button", { name: /install and restart/i });
    // Both clicks dispatch before the state flips, so the guard sees the
    // second install while the first is still in flight.
    await act(async () => {
      fireEvent.click(install);
      fireEvent.click(install);
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("installing"));
    expect(downloadCalls).toBe(1);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/downloading and installing/i);
    expect(dialog.textContent).toMatch(/downloading…/i);
    expect(dialog.textContent).not.toMatch(/%/);
    expect(screen.queryByRole("button", { name: /^close$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /not now/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /install and restart/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^done$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    expect(await simulateDismiss()).toBe("3");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Attempt close" }));
    });
    expect(screen.getByTestId("dialog-open").textContent).toBe("open");
    await act(async () => {
      downloadGate.resolve();
    });
    await waitFor(() => expect(relaunchCalls).toBe(1));
    expect(downloadCalls).toBe(1);
  });

  test("checking blocks dismiss and duplicate checks", async () => {
    const gate = deferred<unknown>();
    checkImpl = () => gate.promise;
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^updates$/i }));
    });
    expect(checkCalls).toBe(1);
    expect(screen.getByTestId("dialog-open").textContent).toBe("open");
    expect(screen.getByRole("dialog").textContent).toMatch(/checking for updates/i);
    expect(screen.queryByRole("button", { name: /not now/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /install and restart/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^done$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^close$/i })).toBeNull();
    expect(await simulateDismiss()).toBe("3");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Attempt close" }));
    });
    expect(screen.getByTestId("dialog-open").textContent).toBe("open");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /checking/i }));
    });
    expect(checkCalls).toBe(1);
    await act(async () => {
      gate.resolve(null);
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("up-to-date"));
    expect(await simulateDismiss()).toBe("0");
  });

  test("up-to-date says the version is current and Done closes", async () => {
    checkImpl = async () => null;
    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^updates$/i }));
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("up-to-date"));
    expect(screen.getByRole("dialog").textContent).toMatch(/installed version is current/i);
    expect(screen.getByRole("button", { name: /^done$/i })).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("errors persist, allow closing, and reopening retries with a fresh check", async () => {
    let attempts = 0;
    const secondGate = deferred<unknown>();
    checkImpl = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network down");
      return secondGate.promise;
    };
    render(<Harness />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^updates$/i }));
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("error"));
    expect(screen.getByRole("dialog").textContent).toContain("network down");
    expect(screen.getByRole("button", { name: /try again/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /^close$/i })).not.toBeNull();
    await act(async () => {});
    expect(screen.getByTestId("updater-state").textContent).toBe("error");
    expect(screen.getByRole("dialog").textContent).toContain("network down");
    // The error dialog allows every close path.
    expect(await simulateDismiss()).toBe("0");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Attempt close" }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    // Reopening performs a fresh check.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /update failed/i }));
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("checking"));
    await act(async () => {
      secondGate.resolve(null);
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("up-to-date"));
    expect(attempts).toBe(2);
  });

  test("install and relaunch failures stay in error for retry", async () => {
    checkImpl = async () =>
      makeFakeUpdate({
        version: "1.2.0",
        body: "notes",
        downloadImpl: async () => {
          throw new Error("install exploded");
        },
      });
    render(<Harness />);
    await openAvailableDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("error"));
    expect(screen.getByRole("dialog").textContent).toContain("install exploded");
    expect(relaunchCalls).toBe(0);
    expect(screen.getByRole("button", { name: /try again/i })).not.toBeNull();
    await act(async () => {});
    expect(screen.getByTestId("updater-state").textContent).toBe("error");

    cleanup();
    resetUpdaterFakes();
    checkImpl = async () => makeFakeUpdate({ version: "1.2.0", body: "notes" });
    relaunchImpl = async () => {
      throw new Error("relaunch exploded");
    };
    render(<Harness />);
    await openAvailableDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("error"));
    expect(screen.getByRole("dialog").textContent).toContain("relaunch exploded");
    expect(downloadCalls).toBe(1);
    expect(screen.getByRole("button", { name: /try again/i })).not.toBeNull();
    await act(async () => {});
    expect(screen.getByTestId("updater-state").textContent).toBe("error");
  });

  test("manual check during silent flight is fresh; stale silent results never land", async () => {
    const silentGate = deferred<unknown>();
    const manualGate = deferred<unknown>();
    let calls = 0;
    checkImpl = () => {
      calls += 1;
      return calls === 1 ? silentGate.promise : manualGate.promise;
    };
    render(<Harness silentOnMount />);
    await waitFor(() => expect(calls).toBe(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^updates$/i }));
    });
    expect(calls).toBe(2);
    expect(screen.getByTestId("dialog-open").textContent).toBe("open");
    expect(screen.getByRole("dialog").textContent).toMatch(/checking for updates/i);
    await act(async () => {
      silentGate.resolve(makeFakeUpdate({ version: "0.0.1", body: "stale" }));
    });
    await act(async () => {});
    // The stale silent result changes nothing: still open, still checking.
    expect(screen.getByTestId("dialog-open").textContent).toBe("open");
    expect(screen.getByTestId("updater-state").textContent).toBe("checking");
    await act(async () => {
      manualGate.resolve(makeFakeUpdate({ version: "7.7.7", body: "fresh" }));
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("available"));
    expect(screen.getByRole("dialog").textContent).toContain("7.7.7");
    expect(screen.getByRole("dialog").textContent).not.toContain("stale");
  });
});
