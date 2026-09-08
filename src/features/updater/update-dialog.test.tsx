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

type BackendRelease = {
  available: boolean;
  version: string;
  date: string;
  notes: string;
};

let checkCalls = 0;
let checkImpl: () => Promise<BackendRelease | null> = async () => null;
let installCalls = 0;
let installImpl: () => Promise<void> = async () => {};
let progressHandlers: Array<(event: { payload: number }) => void> = [];
let unlistenCalls = 0;

function resetUpdaterFakes() {
  checkCalls = 0;
  installCalls = 0;
  progressHandlers = [];
  unlistenCalls = 0;
  checkImpl = async () => null;
  installImpl = async () => {};
  // Re-assert this suite's backend fakes before every test: Bun shares
  // module mocks across files in one process, so another suite's fake must
  // never leak in here (and vice versa).
  mock.module("@tauri-apps/api/core", () => ({
    invoke: (command: string) => {
      if (command === "app_version") return Promise.resolve("0.1.13");
      if (command === "build_date") return Promise.resolve("2026-09-03");
      if (command === "open_url") return Promise.resolve();
      if (command === "check_update") {
        checkCalls += 1;
        return checkImpl();
      }
      if (command === "install_update") {
        installCalls += 1;
        return installImpl();
      }
      throw new Error(`unexpected invoke: ${command}`);
    },
  }));
  mock.module("@tauri-apps/api/event", () => ({
    listen: async (event: string, handler: (event: { payload: number }) => void) => {
      if (event === "update-progress") progressHandlers.push(handler);
      return () => {
        unlistenCalls += 1;
      };
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

mock.module("@tauri-apps/api/core", () => ({
  invoke: (command: string) => {
    if (command === "app_version") return Promise.resolve("0.1.13");
    if (command === "build_date") return Promise.resolve("2026-09-03");
    if (command === "open_url") return Promise.resolve();
    if (command === "check_update") {
      checkCalls += 1;
      return checkImpl();
    }
    if (command === "install_update") {
      installCalls += 1;
      return installImpl();
    }
    throw new Error(`unexpected invoke: ${command}`);
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (event: { payload: number }) => void) => {
    if (event === "update-progress") progressHandlers.push(handler);
    return () => {
      unlistenCalls += 1;
    };
  },
}));

const { cleanup, fireEvent, render, screen, waitFor } = await import("@testing-library/react");
const { AboutButton, AboutDialog } = await import("./about-dialog");
const { UpdateDialog } = await import("./update-dialog");

function makeRelease(opts: {
  available?: boolean;
  version?: string;
  date?: string;
  notes?: string;
}): BackendRelease {
  return {
    available: opts.available ?? true,
    version: opts.version ?? "1.2.0",
    date: opts.date ?? "",
    notes: opts.notes ?? "",
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
  await openAboutAndCheck();
  await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("available"));
}

async function openAboutAndCheck() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /about/i }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));
  });
}

function Harness({ silentOnMount = false }: { silentOnMount?: boolean }) {
  const updater = useUpdaterController();
  const [aboutOpen, setAboutOpen] = useState(false);
  useEffect(() => {
    if (silentOnMount) void updater.checkForUpdates({ silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [silentOnMount]);
  return (
    <div>
      <AboutButton
        onClick={() => setAboutOpen(true)}
        updateAvailable={updater.state === "available"}
      />
      <AboutDialog
        open={aboutOpen}
        updatesEnabled
        updater={updater}
        onOpenChange={setAboutOpen}
      />
      <UpdateDialog open={updater.dialogOpen} updater={updater} onOpenChange={updater.setDialogOpen} />
      <button type="button" aria-label="Attempt check" onClick={() => void updater.checkForUpdates()}>
        Attempt check
      </button>
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

function countOccurrences(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

describe("user-invoked update dialog", () => {
  beforeEach(() => {
    cleanup();
    resetUpdaterFakes();
  });

  test("About shows application details without changelog; changelog lives in Update dialog", async () => {
    checkImpl = async () =>
      makeRelease({
        available: false,
        version: "0.1.13",
        notes: "## What's Changed\n\n- Current release notes",
      });
    render(<Harness silentOnMount />);
    await waitFor(() => expect(checkCalls).toBe(1));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /about/i }));
    });

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Vision Export Studio");
    expect(dialog.textContent).toContain("Open source");
    expect(dialog.textContent).toContain("MIT · github.com/amanharshx/vision-export-studio");
    expect(dialog.textContent).toContain("Built2026-09-03");
    expect(screen.getByRole("img", { name: /github/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /view repository/i })).not.toBeNull();
    expect(screen.getByRole("button", { name: /check for updates/i })).not.toBeNull();
    // The About dialog never renders release notes.
    expect(screen.queryByLabelText(/changelog/i)).toBeNull();
    expect(checkCalls).toBe(1);

    // Clicking Check for Updates closes About and opens the Update dialog with notes.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check for updates/i }));
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("up-to-date"));
    const changelog = await waitFor(() => screen.getByLabelText(/changelog/i));
    expect(changelog.textContent).toContain("Current release notes");
  });

  test("startup stays silent, then a manual click opens checking with a fresh check", async () => {
    const manualGate = deferred<BackendRelease | null>();
    let calls = 0;
    checkImpl = () => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(makeRelease({ version: "9.9.9", notes: "notes" }))
        : manualGate.promise;
    };
    render(<Harness silentOnMount />);
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("available"));
    expect(calls).toBe(1);
    expect(screen.getByTestId("dialog-open").textContent).toBe("closed");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText(/update available/i)).not.toBeNull();

    await openAboutAndCheck();
    expect(calls).toBe(2);
    expect(screen.getByTestId("dialog-open").textContent).toBe("open");
    expect(screen.getByRole("dialog").textContent).toContain("Checking GitHub for the latest release…");
    await act(async () => {
      manualGate.resolve(null);
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("up-to-date"));
  });

  test("available shows exact copy and metadata, invalid metadata omits the date, Not now closes quietly", async () => {
    const body =
      "## What's Changed\n\n- Line one by @amanharshx in https://github.com/amanharshx/vision-export-studio/pull/158\n- Line two";
    checkImpl = async () =>
      makeRelease({ version: "2.4.6", date: "2026-03-14T12:00:00.000Z", notes: body });
    render(<Harness />);
    await openAvailableDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain(
      "Vision Export Studio 2.4.6 is ready to install. The app will restart automatically.",
    );
    expect(dialog.textContent).toContain("Vision Export Studio updates");
    expect(dialog.textContent).toContain("2.4.6");
    expect(dialog.textContent).toContain("2026");
    // The Version row names the available release, not the installed app.
    expect(screen.getByText("Version").nextElementSibling?.textContent).toBe("2.4.6");
    const notes = await waitFor(() => screen.getByLabelText(/changelog/i));
    expect(notes.textContent).toContain("Line one");
    expect(notes.textContent).toContain("Line two");
    expect(screen.getByRole("heading", { name: "What's Changed" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "@amanharshx" })).not.toBeNull();
    expect(screen.getByRole("link", { name: "#158" })).not.toBeNull();
    expect(installCalls).toBe(0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(installCalls).toBe(0);

    cleanup();
    resetUpdaterFakes();
    checkImpl = async () => makeRelease({ version: "3.0.0", date: "not-a-date", notes: "" });
    render(<Harness />);
    await openAvailableDialog();
    expect(screen.getByRole("dialog").textContent).toContain(
      "Vision Export Studio 3.0.0 is ready to install. The app will restart automatically.",
    );
    expect(screen.getByRole("dialog").textContent).not.toMatch(/released/i);
    expect(screen.queryByLabelText(/changelog/i)).toBeNull();
  });

  test("install starts on click, shows percent progress via backend events", async () => {
    checkImpl = async () => makeRelease({ version: "1.2.0", notes: "notes" });
    installImpl = async () => {
      for (const percent of [25, 50]) {
        for (const handler of [...progressHandlers]) handler({ payload: percent });
      }
    };
    render(<Harness />);
    await openAvailableDialog();
    expect(installCalls).toBe(0);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));
    });
    await waitFor(() => expect(screen.getAllByText(/downloading… 50%/i).length).toBeGreaterThan(0));
    expect(screen.getByRole("dialog").textContent).toContain("Downloading and installing the update…");
    await waitFor(() => expect(installCalls).toBe(1));
    expect(screen.getByTestId("updater-state").textContent).toBe("installing");
  });

  test("unknown size is indeterminate; installing blocks dismiss and duplicate installs", async () => {
    const installGate = deferred<void>();
    checkImpl = async () => makeRelease({ version: "1.2.0", notes: "notes" });
    installImpl = () => installGate.promise;
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
    expect(installCalls).toBe(1);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Downloading and installing the update…");
    expect(dialog.textContent).toContain("Downloading…");
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
      installGate.resolve();
    });
    await waitFor(() => expect(installCalls).toBe(1));
    await waitFor(() => expect(unlistenCalls).toBeGreaterThan(0));
  });

  test("checking blocks dismiss and duplicate checks", async () => {
    const gate = deferred<BackendRelease | null>();
    checkImpl = () => gate.promise;
    render(<Harness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await openAboutAndCheck();
    expect(checkCalls).toBe(1);
    expect(screen.getByTestId("dialog-open").textContent).toBe("open");
    expect(screen.getByRole("dialog").textContent).toContain("Checking GitHub for the latest release…");
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
      fireEvent.click(screen.getByRole("button", { name: /attempt check/i }));
    });
    expect(checkCalls).toBe(1);
    await act(async () => {
      gate.resolve(null);
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("up-to-date"));
    expect(await simulateDismiss()).toBe("0");
  });

  test("up-to-date shows the exact sentence once with current release metadata and Done closes", async () => {
    checkImpl = async () =>
      makeRelease({
        available: false,
        version: "0.1.13",
        date: "2026-02-20T12:00:00.000Z",
        notes: "Current notes",
      });
    render(<Harness />);
    await openAboutAndCheck();
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("up-to-date"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("You have the latest version of Vision Export Studio.");
    expect(countOccurrences(dialog.textContent ?? "", "You have the latest version of Vision Export Studio.")).toBe(1);
    expect(dialog.textContent).toContain("0.1.13");
    expect(dialog.textContent).toContain("2026");
    expect(dialog.textContent).toContain("Current notes");
    expect(dialog.textContent).not.toContain("The installed version is current");
    expect(dialog.textContent).not.toContain("...");
    expect(screen.getByRole("button", { name: /^done$/i })).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("errors appear once, allow closing, and reopening retries with a fresh check", async () => {
    let attempts = 0;
    const secondGate = deferred<BackendRelease | null>();
    checkImpl = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("network down");
      return secondGate.promise;
    };
    render(<Harness />);
    await openAboutAndCheck();
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("error"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Update failed: network down");
    expect(countOccurrences(dialog.textContent ?? "", "network down")).toBe(1);
    expect(dialog.textContent).not.toContain("...");
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
    // Reopening About and checking again performs a fresh check.
    await openAboutAndCheck();
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("checking"));
    await act(async () => {
      secondGate.resolve(null);
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("up-to-date"));
    expect(attempts).toBe(2);
  });

  test("install failures stay in error once for retry", async () => {
    checkImpl = async () => makeRelease({ version: "1.2.0", notes: "notes" });
    installImpl = async () => {
      throw new Error("install exploded");
    };
    render(<Harness />);
    await openAvailableDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("error"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Update failed: install exploded");
    expect(countOccurrences(dialog.textContent ?? "", "install exploded")).toBe(1);
    expect(installCalls).toBe(1);
    expect(screen.getByRole("button", { name: /try again/i })).not.toBeNull();
    await act(async () => {});
    expect(screen.getByTestId("updater-state").textContent).toBe("error");

    cleanup();
    resetUpdaterFakes();
    checkImpl = async () => makeRelease({ version: "1.2.0", notes: "notes" });
    installImpl = async () => {
      throw new Error("No update is available to install.");
    };
    render(<Harness />);
    await openAvailableDialog();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /install and restart/i }));
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("error"));
    expect(screen.getByRole("dialog").textContent).toContain(
      "Update failed: No update is available to install.",
    );
    expect(installCalls).toBe(1);
    expect(screen.getByRole("button", { name: /try again/i })).not.toBeNull();
    await act(async () => {});
    expect(screen.getByTestId("updater-state").textContent).toBe("error");
  });

  test("manual check during silent flight is fresh; stale silent results never land", async () => {
    const silentGate = deferred<BackendRelease | null>();
    const manualGate = deferred<BackendRelease | null>();
    let calls = 0;
    checkImpl = () => {
      calls += 1;
      return calls === 1 ? silentGate.promise : manualGate.promise;
    };
    render(<Harness silentOnMount />);
    await waitFor(() => expect(calls).toBe(1));
    expect(screen.queryByRole("dialog")).toBeNull();
    await openAboutAndCheck();
    expect(calls).toBe(2);
    expect(screen.getByTestId("dialog-open").textContent).toBe("open");
    expect(screen.getByRole("dialog").textContent).toContain("Checking GitHub for the latest release…");
    await act(async () => {
      silentGate.resolve(makeRelease({ version: "0.0.1", notes: "stale" }));
    });
    await act(async () => {});
    // The stale silent result changes nothing: still open, still checking.
    expect(screen.getByTestId("dialog-open").textContent).toBe("open");
    expect(screen.getByTestId("updater-state").textContent).toBe("checking");
    await act(async () => {
      manualGate.resolve(makeRelease({ version: "7.7.7", notes: "fresh" }));
    });
    await waitFor(() => expect(screen.getByTestId("updater-state").textContent).toBe("available"));
    expect(screen.getByRole("dialog").textContent).toContain("7.7.7");
    expect(screen.getByRole("dialog").textContent).toContain(
      "Vision Export Studio 7.7.7 is ready to install. The app will restart automatically.",
    );
    expect(screen.getByRole("dialog").textContent).not.toContain("stale");
  });
});
