// @ts-expect-error Bun provides this module at test runtime.
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
afterAll(() => {
  GlobalRegistrator.unregister();
});

import React from "react";
import App from "@/App";
// Dynamic import: @testing-library binds `screen` to document at import
// time, so it must evaluate after GlobalRegistrator above.
const { fireEvent, render, screen, waitFor } = await import("@testing-library/react");
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

const calls = {
  install: [] as unknown[],
  startExport: [] as unknown[],
  rebuild: [] as unknown[],
  cleanup: [] as unknown[],
  saveOverride: [] as unknown[],
  markComplete: [] as unknown[],
  resolveBootstrap: [] as unknown[],
};

function resetScenario() {
  settingsFile = null;
  settingsError = null;
  detectedEnv = null;
  detectError = null;
  stacks = [];
  pickedModelPath = null;
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
  detectEnvironment: () =>
    detectError || !detectedEnv ? Promise.reject(new Error("no python")) : Promise.resolve(detectedEnv),
}));

mock.module("@/lib/tauri/app", () => ({
  getAppTelemetryContext: () => Promise.resolve({ os: "macos", arch: "arm64" }),
  getRoutePlatformSupport: (routeIds: string[]): Promise<HostSupportResult[]> => Promise.resolve([]),
}));

mock.module("@/lib/tauri/stack-environments", () => ({
  listStackEnvironments: () => Promise.resolve(stacks),
}));

mock.module("@/lib/tauri/managed-environments", () => ({
  scanManagedEnvironments: (): Promise<ManagedEnvironmentScanResult[]> => Promise.resolve([]),
  cleanupManagedEnvironments: (...args: unknown[]) => {
    calls.cleanup.push(args);
    return Promise.resolve({ results: [], setup_complete: null, setup_error: null });
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
