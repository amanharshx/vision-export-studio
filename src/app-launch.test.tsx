// @ts-expect-error Bun provides this module at test runtime.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered for the whole test process (no unregister): React may still
// have scheduled work when a file finishes, and other suites tolerate the
// globals (verified by the full run).
GlobalRegistrator.register();

import React from "react";
import App from "@/App";
// Dynamic import: @testing-library binds `screen` to document at import
// time, so it must evaluate after GlobalRegistrator above.
const { fireEvent, render, screen, waitFor, within } = await import("@testing-library/react");
import type {
  AppSettings,
  DepCheckResult,
  EnvironmentInfo,
  ManagedEnvironmentScanResult,
  StackEnvironment,
} from "@/lib/types";
import type { HostSupportResult } from "@/lib/tauri/app";
import type { UpdaterController } from "@/features/updater/use-updater-controller";

// Ticket 12 launch contract, exercised through the real App: landing renders
// without the retired Setup screen, Get Started opens model upload for every
// provider inventory with either legacy setup_complete value, settings
// restore, and no setup work starts on launch, upload, or entry.

const MANAGED_PYTHON = "/tmp/runtime/.venv/bin/python";
const STACK_PYTHON = "/tmp/runtime/envs/rfdetr-default/.venv/bin/python";

const MANAGED_ENV: EnvironmentInfo = {
  python_path: MANAGED_PYTHON,
  python_version: "Python 3.12.14",
  yolo_path: "/tmp/runtime/.venv/bin/yolo",
  ultralytics_version: "8.4.142",
  status: "ok",
  warnings: [],
};

const DEFAULT_STACK: StackEnvironment = {
  key: "rfdetr-default",
  display_name: "RF-DETR",
  route_ids: ["rfdetr.pth.onnx", "rfdetr.pth.executorch"],
  python_path: STACK_PYTHON,
  python_version: { status: "available", version: "3.12.14" },
  rfdetr_version: { status: "available", version: "1.9.0" },
};

function readyResults(): DepCheckResult[] {
  return [{ item: "dep", status: "ready", reason: "", install_hint: "pip install dep" }];
}

// Mutable scenario holders read by the Tauri fakes below at call time.
let settingsFile: AppSettings | null = null;
let settingsError: string | null = null;
let detectedEnv: EnvironmentInfo | null = null;
let detectError: string | null = null;
let stacks: StackEnvironment[] = [];
let pickedModelPath: string | null = null;
let scanRows: ManagedEnvironmentScanResult[] | null = null;

const calls = {
  install: [] as unknown[],
  startExport: [] as unknown[],
  rebuild: [] as unknown[],
  cleanup: [] as unknown[],
  saveOverride: [] as unknown[],
  markComplete: [] as unknown[],
  resolveBootstrap: [] as unknown[],
  detect: [] as unknown[],
};

function resetScenario() {
  settingsFile = null;
  settingsError = null;
  detectedEnv = null;
  detectError = null;
  stacks = [];
  pickedModelPath = null;
  scanRows = null;
  for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = [];
}

const idleUpdater: UpdaterController = {
  state: "idle",
  version: "",
  progress: 0,
  error: "",
  hasDismissedAnnouncementThisSession: false,
  checkForUpdates: async () => {},
  beginInstall: async () => {},
  restartToUpdate: async () => {},
  dismissAnnouncement: () => {},
};

mock.module("@/features/updater/use-updater-controller", () => ({
  useUpdaterController: () => idleUpdater,
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async () => () => {},
}));

mock.module("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
    onDragDropEvent: async () => () => {},
  }),
}));

mock.module("@tauri-apps/plugin-dialog", () => ({
  confirm: async () => false,
}));

// Radix Dialog/Sheet portals never mount under happy-dom, so no overlay UI
// can open in client-rendered tests. These faithful passthroughs preserve the
// open contract (closed renders nothing, open renders children inline) while
// leaving every other UI module untouched.
type OverlayMockProps = {
  open?: boolean;
  children?: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
  [key: string]: unknown;
};

function mockOverlayModules() {
  const passthrough = ({ children }: OverlayMockProps) => <>{children}</>;
  const root = ({ open, children }: OverlayMockProps) => (open ? <>{children}</> : null);
  const content = ({ children }: OverlayMockProps) => <div role="dialog">{children}</div>;
  const overlay = () => null;
  const title = ({ children }: OverlayMockProps) => <h2>{children}</h2>;
  const description = ({ children }: OverlayMockProps) => <p>{children}</p>;
  const section = ({ children }: OverlayMockProps) => <div>{children}</div>;
  return { passthrough, root, content, overlay, title, description, section };
}

mock.module("@/components/ui/sheet", () => {
  const { passthrough, root, content, overlay, title, description, section } = mockOverlayModules();
  return {
    Sheet: root,
    SheetTrigger: passthrough,
    SheetClose: passthrough,
    SheetPortal: passthrough,
    SheetOverlay: overlay,
    SheetContent: content,
    SheetHeader: section,
    SheetFooter: section,
    SheetTitle: title,
    SheetDescription: description,
  };
});

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

mock.module("@/lib/tauri/setup", () => ({
  loadSettings: () =>
    settingsError ? Promise.reject(new Error(settingsError)) : Promise.resolve(settingsFile),
  savePythonOverride: (override: string | null) => {
    calls.saveOverride.push(override);
    return Promise.resolve();
  },
  saveOutputDirOverride: () => Promise.resolve(),
  ultralyticsSetupReadiness: () =>
    Promise.resolve({ managed_python: MANAGED_PYTHON, needs_work: true }),
  getManagedRuntimeRebuildEligibility: () =>
    Promise.resolve({ eligible: false, current_version: "", candidate_version: null }),
  rebuildManagedRuntime: (...args: unknown[]) => {
    calls.rebuild.push(args);
    return Promise.resolve("session-1");
  },
  markSetupComplete: (...args: unknown[]) => {
    calls.markComplete.push(args);
    return Promise.resolve();
  },
}));

mock.module("@/lib/tauri/environment", () => ({
  detectEnvironment: (...args: unknown[]) => {
    calls.detect.push(args);
    return detectError || !detectedEnv
      ? Promise.reject(new Error("no python"))
      : Promise.resolve(detectedEnv);
  },
}));

mock.module("@/lib/tauri/app", () => ({
  getAppTelemetryContext: () => Promise.resolve({ os: "macos", arch: "arm64" }),
  getRoutePlatformSupport: (routeIds: string[]): Promise<HostSupportResult[]> => Promise.resolve([]),
}));

mock.module("@/lib/tauri/stack-environments", () => ({
  listStackEnvironments: () => Promise.resolve(stacks),
}));

mock.module("@/lib/tauri/managed-environments", () => ({
  scanManagedEnvironments: (keys: string[]): Promise<ManagedEnvironmentScanResult[]> =>
    Promise.resolve((scanRows ?? []).filter((row) => keys.includes(row.key))),
  cleanupManagedEnvironments: (keys: string[]) => {
    calls.cleanup.push([keys]);
    // Faithful deletion simulation: the fake backend removes exactly the
    // requested environments so post-cleanup probes observe their absence.
    if (keys.includes("ultralytics-managed")) detectedEnv = null;
    if (keys.includes("rfdetr-all")) stacks = [];
    else if (keys.some((key) => key.startsWith("rfdetr-"))) {
      stacks = stacks.filter((stack) => !keys.includes(stack.key));
    }
    return Promise.resolve({
      results: keys.map((key) => ({ status: "succeeded", key, estimated_logical_bytes: 10 })),
      setup_complete: null,
      setup_error: null,
    });
  },
}));

mock.module("@/lib/tauri/deps", () => ({
  checkDependencies: () => Promise.resolve({ results: readyResults() }),
  installDependencies: (...args: unknown[]) => {
    calls.install.push(args);
    return Promise.resolve("session-1");
  },
}));

mock.module("@/lib/tauri/export", () => ({
  startExport: (...args: unknown[]) => {
    calls.startExport.push(args);
    return Promise.resolve("session-1");
  },
  cancelExport: () => Promise.resolve(true),
  openExportFolder: () => Promise.resolve(),
}));

mock.module("@/lib/tauri/rfdetr", () => ({
  getRfDetrCheckpointIdentity: () => Promise.reject(new Error("unused")),
  inspectRfDetrCheckpoint: () => Promise.reject(new Error("unused")),
}));

mock.module("@/lib/tauri/bootstrap-python", () => ({
  resolveBootstrapPython: (...args: unknown[]) => {
    calls.resolveBootstrap.push(args);
    return Promise.reject(new Error("unused"));
  },
  // Faithful copy of the real predicate: bun shares mocked modules across
  // test files in one process, and setup-task flows depend on the real
  // missing/invalid_override semantics. Never stubbed to a constant.
  isPythonRequiredResult: (result: { status: string }) =>
    result.status === "missing" || result.status === "invalid_override",
}));

mock.module("@/lib/tauri/dialog", () => ({
  openModelFilePicker: () => Promise.resolve(pickedModelPath),
  openCalibrationDataPicker: () => Promise.resolve(null),
  openPythonExecutablePicker: () => Promise.resolve(null),
  openRuntimeDirPicker: () => Promise.resolve(null),
  openOutputDirPicker: () => Promise.resolve(null),
}));

function baseSettings(overrides: Partial<AppSettings> = {}): AppSettings {
  return {
    runtime_dir: "/tmp/runtime",
    setup_complete: false,
    python_path_override: undefined,
    output_dir_override: undefined,
    ...overrides,
  };
}

async function launchAndEnterWorkspace() {
  render(React.createElement(App, null));
  const getStarted = await screen.findByRole("button", { name: /get started/i });
  await waitFor(() => {
    expect((getStarted as HTMLButtonElement).disabled).toBe(false);
  });
  expect(screen.queryByText("Set up Vision Export Studio")).toBeNull();
  fireEvent.click(getStarted);
  await screen.findByRole("button", { name: "Roboflow RF-DETR" });
  expect(screen.queryByText("Set up Vision Export Studio")).toBeNull();
}

function expectNoSetupStarted() {
  expect(calls.install).toEqual([]);
  expect(calls.startExport).toEqual([]);
  expect(calls.rebuild).toEqual([]);
  expect(calls.cleanup).toEqual([]);
  expect(calls.saveOverride).toEqual([]);
  expect(calls.markComplete).toEqual([]);
  expect(calls.resolveBootstrap).toEqual([]);
}

describe("workspace launch without global runtime (ticket 12)", () => {
  beforeEach(() => {
    resetScenario();
  });

  test("fresh launch with no settings file opens upload and starts nothing", async () => {
    settingsError = "no settings file";
    await launchAndEnterWorkspace();
    expectNoSetupStarted();
  });

  test("restart with setup_complete false and no environments opens upload", async () => {
    settingsFile = baseSettings({ setup_complete: false });
    detectError = "no python";
    await launchAndEnterWorkspace();
    expectNoSetupStarted();
  });

  test("restart with setup_complete true and Ultralytics-only opens upload", async () => {
    settingsFile = baseSettings({ setup_complete: true });
    detectedEnv = MANAGED_ENV;
    await launchAndEnterWorkspace();
    expectNoSetupStarted();
  });

  test("restart with RF-DETR-only opens upload", async () => {
    settingsFile = baseSettings({ setup_complete: false });
    detectError = "no python";
    stacks = [DEFAULT_STACK];
    await launchAndEnterWorkspace();
    expectNoSetupStarted();
  });

  test("restart with both providers opens upload", async () => {
    settingsFile = baseSettings({ setup_complete: true });
    detectedEnv = MANAGED_ENV;
    stacks = [DEFAULT_STACK];
    await launchAndEnterWorkspace();
    expectNoSetupStarted();
  });

  test("model upload alone starts no setup", async () => {
    settingsFile = baseSettings({ setup_complete: false });
    detectError = "no python";
    pickedModelPath = "/tmp/best.pt";
    await launchAndEnterWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Browse file" }));
    await screen.findByText("Export Target");
    expect(screen.queryByText("Set up Vision Export Studio")).toBeNull();
    expectNoSetupStarted();
  });
});

describe("workspace stability after environment cleanup (ticket 13)", () => {
  beforeEach(() => {
    resetScenario();
  });

  const ultraRow: ManagedEnvironmentScanResult = {
    key: "ultralytics-managed",
    status: "available",
    estimated_logical_bytes: 1024,
    size_error: null,
    exists: true,
  };
  const rfdetrRow: ManagedEnvironmentScanResult = {
    key: "rfdetr-default",
    status: "available",
    estimated_logical_bytes: 2048,
    size_error: null,
    exists: true,
  };

  function bothProvidersWithModel() {
    settingsFile = baseSettings({ setup_complete: true });
    detectedEnv = MANAGED_ENV;
    stacks = [DEFAULT_STACK];
    pickedModelPath = "/tmp/best.pt";
    scanRows = [ultraRow, rfdetrRow];
  }

  async function uploadModel() {
    fireEvent.click(screen.getByRole("button", { name: "Browse file" }));
    await screen.findByText("Export Target");
    expect(screen.getByText("best.pt")).not.toBeNull();
  }

  async function clickEnabledButton(name: string | RegExp) {
    await waitFor(() => {
      const button = screen.getByRole("button", { name });
      if ((button as HTMLButtonElement).disabled) throw new Error("waiting for enabled button");
      fireEvent.click(button);
    });
  }

  async function confirmCleanupDialog(titleText: string, confirmName: string) {
    const title = await screen.findByText(titleText);
    const dialog = title.closest('[role="dialog"]');
    expect(dialog).not.toBeNull();
    fireEvent.click(
      within(dialog as HTMLElement).getByRole("button", { name: confirmName }),
    );
  }

  test("removing Ultralytics keeps the model, upload, and healthy RF-DETR routes", async () => {
    bothProvidersWithModel();
    await launchAndEnterWorkspace();
    await uploadModel();
    const detectCallsBefore = calls.detect.length;
    expect(detectCallsBefore).toBeGreaterThan(0);

    fireEvent.click(screen.getByTitle("Environment & settings"));
    await clickEnabledButton(/Ultralytics YOLO Ready/);
    await clickEnabledButton("Reset runtime");

    // Concise on-demand recreation copy replaces last-runtime warnings.
    await screen.findByText("Reset Ultralytics runtime?");
    expect(
      screen.getByText("This environment will be set up again when needed."),
    ).not.toBeNull();
    expect(screen.queryByText(/last managed runtime/i)).toBeNull();
    await confirmCleanupDialog("Reset Ultralytics runtime?", "Reset runtime");

    await waitFor(() => expect(calls.cleanup).toEqual([[["ultralytics-managed"]]]));
    // Probes refresh after removal so affected routes report honestly.
    await waitFor(() => expect(calls.detect.length).toBeGreaterThan(detectCallsBefore));
    // The workspace stays put with the model; upload-era navigation is gone.
    expect(screen.getByText("Export Target")).not.toBeNull();
    expect(screen.getByText("best.pt")).not.toBeNull();
    expect(screen.queryByText("Set up Vision Export Studio")).toBeNull();
    // The affected provider reports its honest missing state while the
    // healthy RF-DETR stack is untouched.
    await screen.findByRole("button", { name: /Ultralytics YOLO Missing/ });
    expect(screen.getByRole("button", { name: /Roboflow RF-DETR 1 installed/ })).not.toBeNull();
    // Legacy global setup state is never rewritten by cleanup.
    expect(calls.markComplete).toEqual([]);
    expect(calls.saveOverride).toEqual([]);
  });

  test("removing one RF-DETR stack keeps healthy Ultralytics routes and the model", async () => {
    bothProvidersWithModel();
    await launchAndEnterWorkspace();
    await uploadModel();

    fireEvent.click(screen.getByTitle("Environment & settings"));
    await clickEnabledButton(/Roboflow RF-DETR 1 installed/);
    await clickEnabledButton(/RF-DETR 1\.9\.0/);
    await clickEnabledButton("Remove");
    await confirmCleanupDialog("Remove RF-DETR environment?", "Remove");

    await waitFor(() => expect(calls.cleanup).toEqual([[["rfdetr-default"]]]));
    expect(screen.getByText("Export Target")).not.toBeNull();
    expect(screen.getByText("best.pt")).not.toBeNull();
    expect(screen.queryByText("Set up Vision Export Studio")).toBeNull();
    // The removed stack is gone; the healthy Ultralytics runtime is intact.
    await screen.findByText("No RF-DETR environments installed");
    expect(
      screen.getByRole("button", { name: /Ultralytics YOLO Ready/ }),
    ).not.toBeNull();
    expect(calls.markComplete).toEqual([]);
    expect(calls.saveOverride).toEqual([]);
  });

  test("model upload stays usable after removing the final environment", async () => {
    settingsFile = baseSettings({ setup_complete: true });
    detectedEnv = MANAGED_ENV;
    stacks = [];
    scanRows = [ultraRow];
    await launchAndEnterWorkspace();

    fireEvent.click(screen.getByTitle("Environment & settings"));
    await clickEnabledButton(/Ultralytics YOLO Ready/);
    await clickEnabledButton("Reset runtime");
    await confirmCleanupDialog("Reset Ultralytics runtime?", "Reset runtime");

    await waitFor(() => expect(calls.cleanup).toEqual([[["ultralytics-managed"]]]));
    // Still on model upload with no provider environments and no redirects.
    expect(screen.getByRole("button", { name: "Browse file" })).not.toBeNull();
    expect(screen.queryByText("Set up Vision Export Studio")).toBeNull();
    await screen.findByRole("button", { name: /Ultralytics YOLO Missing/ });

    // Uploading a model afterwards opens the workspace without any setup.
    pickedModelPath = "/tmp/best.pt";
    fireEvent.click(screen.getByRole("button", { name: "Browse file" }));
    await screen.findByText("Export Target");
    expect(screen.getByText("best.pt")).not.toBeNull();
    expect(screen.queryByText("Set up Vision Export Studio")).toBeNull();
    expect(calls.markComplete).toEqual([]);
  });
});
