// @ts-expect-error Bun provides this module at test runtime.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered for the whole test process (no unregister): React may still
// have scheduled work when a file finishes, and other suites tolerate the
// globals (verified by the full run).
GlobalRegistrator.register();

import React from "react";
import { act } from "react";
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

// Launch contract, exercised through the real App: landing renders
// without the retired Setup screen, Get Started opens model upload for every
// provider inventory, settings restore, and no setup work starts on launch,
// upload, or entry. The retired setup_complete flag is gone from the
// contract; legacy payloads carrying it behave identically.

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
  resolveBootstrap: [] as unknown[],
  detect: [] as unknown[],
  depCheck: [] as unknown[],
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
  // Re-assert this suite's updater fakes before every test: Bun shares
  // module mocks across files in one process, so the updater suite's
  // counting fakes must never leak in here (and vice versa).
  mock.module("@tauri-apps/plugin-updater", () => ({
    check: async () => null,
  }));
  mock.module("@tauri-apps/plugin-process", () => ({
    relaunch: async () => {},
  }));
}

// The App exercises the real updater controller here. Startup performs a
// silent check against this fake (no update available), which stays idle
// with the dialog closed, so launch and Environment flows observe the same
// quiet updater state the idle stub used to provide.
mock.module("@tauri-apps/plugin-updater", () => ({
  check: async () => null,
}));

mock.module("@tauri-apps/plugin-process", () => ({
  relaunch: async () => {},
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
  showCloseButton?: boolean;
  [key: string]: unknown;
};

function mockOverlayModules() {
  const passthrough = ({ children }: OverlayMockProps) => <>{children}</>;
  const root = ({ open, children }: OverlayMockProps) => (open ? <>{children}</> : null);
  const content = ({ children, showCloseButton }: OverlayMockProps) => (
    <div role="dialog">
      {children}
      {showCloseButton ? (
        <button type="button" aria-label="Close">
          Close
        </button>
      ) : null}
    </div>
  );
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
    Promise.resolve(
      (scanRows ?? []).filter(
        (row) => keys.includes(row.key) || (keys.includes("rfdetr-all") && row.key.startsWith("rfdetr-")),
      ),
    ),
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
    });
  },
}));

mock.module("@/lib/tauri/deps", () => ({
  checkDependencies: (...args: unknown[]) => {
    calls.depCheck.push(args);
    return Promise.resolve({ results: readyResults() });
  },
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
    python_path_override: undefined,
    output_dir_override: undefined,
    ...overrides,
  };
}

function legacySettings(overrides: Partial<AppSettings> = {}, setupComplete: boolean): AppSettings {
  // Simulates an older settings file still carrying the retired flag: the
  // extra field must be ignored by the workspace.
  return {
    ...baseSettings(overrides),
    setup_complete: setupComplete,
  } as unknown as AppSettings;
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
  expect(calls.resolveBootstrap).toEqual([]);
}

describe("workspace launch without global runtime", () => {
  beforeEach(() => {
    resetScenario();
  });

  test("fresh launch with no settings file opens upload and starts nothing", async () => {
    settingsError = "no settings file";
    await launchAndEnterWorkspace();
    expectNoSetupStarted();
  });

  test("restart with new settings and no environments opens upload", async () => {
    settingsFile = baseSettings();
    detectError = "no python";
    await launchAndEnterWorkspace();
    expectNoSetupStarted();
  });

  test("restart with Ultralytics-only opens upload", async () => {
    settingsFile = baseSettings();
    detectedEnv = MANAGED_ENV;
    await launchAndEnterWorkspace();
    expectNoSetupStarted();
  });

  test("restart with RF-DETR-only opens upload", async () => {
    settingsFile = baseSettings();
    detectError = "no python";
    stacks = [DEFAULT_STACK];
    await launchAndEnterWorkspace();
    expectNoSetupStarted();
  });

  test("restart with both providers opens upload", async () => {
    settingsFile = baseSettings();
    detectedEnv = MANAGED_ENV;
    stacks = [DEFAULT_STACK];
    await launchAndEnterWorkspace();
    expectNoSetupStarted();
  });

  test("legacy settings with setup_complete false open upload and start nothing", async () => {
    settingsFile = legacySettings({}, false);
    detectError = "no python";
    await launchAndEnterWorkspace();
    expectNoSetupStarted();
  });

  test("legacy settings with setup_complete true open upload and start nothing", async () => {
    settingsFile = legacySettings({}, true);
    detectedEnv = MANAGED_ENV;
    stacks = [DEFAULT_STACK];
    await launchAndEnterWorkspace();
    expectNoSetupStarted();
  });

  test("model upload alone starts no setup", async () => {
    settingsFile = baseSettings();
    detectError = "no python";
    pickedModelPath = "/tmp/best.pt";
    await launchAndEnterWorkspace();
    fireEvent.click(screen.getByRole("button", { name: "Browse file" }));
    await screen.findByText("Export Target");
    expect(screen.queryByText("Set up Vision Export Studio")).toBeNull();
    expectNoSetupStarted();
  });
});

describe("workspace stability after environment cleanup", () => {
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

  function bothProvidersWithModel(overrides: { python_path_override?: string } = {}) {
    settingsFile = baseSettings({ output_dir_override: "/tmp/exports-out", ...overrides });
    detectedEnv = MANAGED_ENV;
    stacks = [DEFAULT_STACK];
    pickedModelPath = "/tmp/best.pt";
    scanRows = [ultraRow, rfdetrRow];
  }

  async function uploadModel(expectedBase = "best.pt") {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Browse file" }));
    });
    await screen.findByText("Export Target");
    expect(screen.getByText(expectedBase)).not.toBeNull();
  }

  async function clickElement(element: HTMLElement) {
    await act(async () => {
      fireEvent.click(element);
    });
  }

  async function clickEnabledButton(name: string | RegExp) {
    const button = await waitFor(() => {
      const candidate = screen.getByRole("button", { name });
      if ((candidate as HTMLButtonElement).disabled) throw new Error("waiting for enabled button");
      return candidate;
    });
    await clickElement(button as HTMLElement);
  }

  async function confirmCleanupDialog(titleText: string, confirmName: string) {
    const title = await screen.findByText(titleText);
    const dialog = title.closest('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await clickElement(
      within(dialog as HTMLElement).getByRole("button", { name: confirmName }),
    );
  }

  async function flushPendingUpdates() {
    // Drain trailing promise chains (unawaited inventory/size refreshes)
    // inside act so no state update lands outside a synchronized scope.
    await act(async () => {});
  }

  function expectStableWorkspaceWithModel(modelBase: string) {
    expect(screen.getByText("Export Target")).not.toBeNull();
    expect(screen.getByText(modelBase)).not.toBeNull();
    expect(screen.queryByText("Set up Vision Export Studio")).toBeNull();
    expect(calls.saveOverride).toEqual([]);
  }

  test("removing Ultralytics keeps the model, upload, and healthy RF-DETR routes", async () => {
    bothProvidersWithModel();
    await launchAndEnterWorkspace();
    await uploadModel();
    const detectCallsBefore = calls.detect.length;
    expect(detectCallsBefore).toBeGreaterThan(0);

    await clickElement(screen.getByTitle("Environment & settings"));
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
    expectStableWorkspaceWithModel("best.pt");
    // The affected provider reports its honest missing state while the
    // healthy RF-DETR stack is untouched.
    await screen.findByRole("button", { name: /Ultralytics YOLO Missing/ });
    expect(screen.getByRole("button", { name: /Roboflow RF-DETR 1 installed/ })).not.toBeNull();
    // Output settings and the (empty) Python selection survive cleanup.
    expect((screen.getByDisplayValue("/tmp/exports-out") as HTMLInputElement).value).toBe("/tmp/exports-out");
    expect((screen.getByPlaceholderText("Auto-detect compatible Python") as HTMLInputElement).value).toBe("");
    expectStableWorkspaceWithModel("best.pt");
    await flushPendingUpdates();
  });

  test("removing one RF-DETR stack keeps healthy Ultralytics routes and the model", async () => {
    bothProvidersWithModel();
    await launchAndEnterWorkspace();
    await uploadModel();

    await clickElement(screen.getByTitle("Environment & settings"));
    await clickEnabledButton(/Roboflow RF-DETR 1 installed/);
    await clickEnabledButton(/RF-DETR 1\.9\.0/);
    await clickEnabledButton("Remove");
    await confirmCleanupDialog("Remove RF-DETR environment?", "Remove");

    await waitFor(() => expect(calls.cleanup).toEqual([[["rfdetr-default"]]]));
    expectStableWorkspaceWithModel("best.pt");
    // The removed stack is gone; the healthy Ultralytics runtime is intact.
    await screen.findByText("No RF-DETR environments installed");
    expect(
      screen.getByRole("button", { name: /Ultralytics YOLO Ready/ }),
    ).not.toBeNull();
    // The untouched provider was re-probed with its own interpreter.
    await waitFor(() =>
      expect(calls.depCheck.at(-1)).toEqual(["ultralytics.pt.onnx", MANAGED_PYTHON]),
    );
    await flushPendingUpdates();
  });

  test("model upload stays usable after removing the final environment", async () => {
    settingsFile = baseSettings();
    detectedEnv = MANAGED_ENV;
    stacks = [];
    scanRows = [ultraRow];
    await launchAndEnterWorkspace();

    await clickElement(screen.getByTitle("Environment & settings"));
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
    await clickElement(screen.getByRole("button", { name: "Browse file" }));
    await screen.findByText("Export Target");
    expectStableWorkspaceWithModel("best.pt");
    await flushPendingUpdates();
  });

  test("removing all RF-DETR stacks re-probes the untouched Ultralytics routes", async () => {
    bothProvidersWithModel({ python_path_override: "/custom/python" });
    await launchAndEnterWorkspace();
    await uploadModel();

    await clickElement(screen.getByTitle("Environment & settings"));
    await clickEnabledButton(/Roboflow RF-DETR 1 installed/);
    await clickEnabledButton("Remove all");
    await screen.findByText("Remove RF-DETR environments?");
    expect(
      screen.getByText("Your bootstrap Python stays saved. These environments will be set up again when needed."),
    ).not.toBeNull();
    expect(screen.queryByText(/last managed runtime/i)).toBeNull();
    await confirmCleanupDialog("Remove RF-DETR environments?", "Remove all");

    await waitFor(() => expect(calls.cleanup).toEqual([[["rfdetr-all"]]]));
    expectStableWorkspaceWithModel("best.pt");
    await screen.findByText("No RF-DETR environments installed");
    expect(
      screen.getByRole("button", { name: /Ultralytics YOLO Ready/ }),
    ).not.toBeNull();
    // The untouched provider was re-probed with its own interpreter.
    await waitFor(() =>
      expect(calls.depCheck.at(-1)).toEqual(["ultralytics.pt.onnx", MANAGED_PYTHON]),
    );
    await flushPendingUpdates();
  });

  test("removing the selected RF-DETR stack re-probes the affected route", async () => {
    settingsFile = baseSettings();
    detectError = "no python";
    stacks = [DEFAULT_STACK];
    pickedModelPath = "/tmp/model.pth";
    scanRows = [rfdetrRow];
    await launchAndEnterWorkspace();
    await clickElement(screen.getByRole("button", { name: "Roboflow RF-DETR" }));
    await uploadModel("model.pth");

    await clickElement(screen.getByTitle("Environment & settings"));
    await clickEnabledButton(/Roboflow RF-DETR 1 installed/);
    await clickEnabledButton(/RF-DETR 1\.9\.0/);
    await clickEnabledButton("Remove");
    await confirmCleanupDialog("Remove RF-DETR environment?", "Remove");

    await waitFor(() => expect(calls.cleanup).toEqual([[["rfdetr-default"]]]));
    expectStableWorkspaceWithModel("model.pth");
    await screen.findByText("No RF-DETR environments installed");
    // The affected route is re-probed through its own stack mapping (the
    // route id doubles as the interpreter argument), even with no
    // Ultralytics environment present.
    await waitFor(() =>
      expect(calls.depCheck.at(-1)).toEqual(["rfdetr.pth.onnx", "rfdetr.pth.onnx"]),
    );
    await flushPendingUpdates();
  });

  test("post-cleanup redetect uses the managed runtime, preserving unsaved edits", async () => {
    settingsFile = baseSettings({
      python_path_override: "/custom/python",
      output_dir_override: "/tmp/exports-out",
    });
    detectedEnv = MANAGED_ENV;
    stacks = [];
    pickedModelPath = "/tmp/best.pt";
    scanRows = [ultraRow];
    await launchAndEnterWorkspace();
    await uploadModel();

    await clickElement(screen.getByTitle("Environment & settings"));
    // Draft an unsaved override edit; the applied value stays saved.
    await act(async () => {
      fireEvent.change(
        screen.getByPlaceholderText("Auto-detect compatible Python"),
        { target: { value: "/custom/python-draft" } },
      );
    });
    await clickEnabledButton(/Ultralytics YOLO Ready/);
    await clickEnabledButton("Reset runtime");
    await screen.findByText("Reset Ultralytics runtime?");
    expect(
      screen.getByText("Your bootstrap Python stays saved. This environment will be set up again when needed."),
    ).not.toBeNull();
    await confirmCleanupDialog("Reset Ultralytics runtime?", "Reset runtime");

    await waitFor(() => expect(calls.cleanup).toEqual([[["ultralytics-managed"]]]));
    // Probes refresh with the managed runtime, never the saved
    // bootstrap override or the unsaved draft.
    await waitFor(() => expect(calls.detect.at(-1)).toEqual([MANAGED_PYTHON]));
    // Draft text, output settings, and the model all survive cleanup.
    expect((screen.getByPlaceholderText("Auto-detect compatible Python") as HTMLInputElement).value)
      .toBe("/custom/python-draft");
    expect((screen.getByDisplayValue("/tmp/exports-out") as HTMLInputElement).value).toBe("/tmp/exports-out");
    expectStableWorkspaceWithModel("best.pt");
    await flushPendingUpdates();
  });

  test("a saved override loads but detection probes the managed runtime", async () => {
    settingsFile = baseSettings({
      python_path_override: "/custom/python",
    });
    detectedEnv = MANAGED_ENV;
    stacks = [];
    pickedModelPath = "/tmp/best.pt";
    await launchAndEnterWorkspace();
    await uploadModel();

    // Mount detection never runs through the saved override.
    await waitFor(() => expect(calls.detect.length).toBeGreaterThan(0));
    expect(calls.detect[0]).toEqual([MANAGED_PYTHON]);

    await clickElement(screen.getByTitle("Environment & settings"));
    // Migration preserves the saved path in the bootstrap field.
    expect(
      (screen.getByPlaceholderText("Auto-detect compatible Python") as HTMLInputElement).value,
    ).toBe("/custom/python");
    // New behavior is explained where the override is configured.
    expect(screen.getByText("Bootstrap Python")).not.toBeNull();
    expect(
      screen.getByText(/only to create isolated export environments/),
    ).not.toBeNull();
    expect(
      screen.getByText(/never into your Python/),
    ).not.toBeNull();
    await flushPendingUpdates();
  });

  test("managed routes stay ready with an override and dep checks use managed", async () => {
    bothProvidersWithModel({ python_path_override: "/custom/python" });
    await launchAndEnterWorkspace();
    await uploadModel();

    // Ultralytics stays Ready via its managed interpreter, independent of
    // the saved bootstrap override.
    await clickElement(screen.getByTitle("Environment & settings"));
    expect(screen.getByRole("button", { name: /Ultralytics YOLO Ready/ })).not.toBeNull();
    await waitFor(() =>
      expect(calls.depCheck.at(-1)).toEqual(["ultralytics.pt.onnx", MANAGED_PYTHON]),
    );
    await flushPendingUpdates();
  });
});
