import { type ReactNode, useEffect, useRef, useState } from "react";
import { ExportWorkspace } from "@/features/export/export-workspace";
import { AboutDialog } from "@/features/updater/about-dialog";
import { UpdateDialog } from "@/features/updater/update-dialog";
import { useUpdaterController } from "@/features/updater/use-updater-controller";
import { LandingScreen } from "@/features/landing-screen";
import { SetupActivityBar } from "@/features/setup/setup-activity-bar";
import { SetupTaskProvider, useSetupTask } from "@/features/setup/setup-task-context";
import {
  captureAnalyticsEvent,
  hasSentFirstRun,
  isAnalyticsEnabled,
  markFirstRunSent,
  shouldCaptureFirstRun,
} from "@/lib/analytics";
import { loadSettings } from "@/lib/tauri/setup";

// Fills the macOS title bar zone (fullSizeContentView) with the correct dark background.
// Uses env(safe-area-inset-top) which Tauri WKWebView sets to the title bar height.
const TitleBarFill = () => (
  <div
    style={{
      position: "fixed",
      top: 0,
      left: 0,
      right: 0,
      height: "env(safe-area-inset-top, 0px)",
      backgroundColor: "#1c1c1e",
      zIndex: 9999,
    }}
  />
);

type AppState = "landing" | "export";

function SetupActivityBarHost() {
  const { task, openDetails, closeDetails, dismissTask } = useSetupTask();
  return (
    <SetupActivityBar
      task={task}
      onOpenDetails={openDetails}
      onCloseDetails={closeDetails}
      onDismiss={dismissTask}
    />
  );
}

function App() {
  const updatesEnabled = !import.meta.env.DEV;
  const [appState, setAppState] = useState<AppState>("landing");
  const [aboutOpen, setAboutOpen] = useState(false);
  // The retired global setup flag is gone. Navigation and
  // readiness are inventory-driven; only settings load gates first-run and
  // update checks.
  const [settingsReady, setSettingsReady] = useState(false);
  const [hasCheckedForUpdateThisLaunch, setHasCheckedForUpdateThisLaunch] = useState(false);
  const appOpenedSentRef = useRef(false);
  const firstRunSentRef = useRef(false);
  const updater = useUpdaterController();

  // Suppress accidental selections starting on marked empty backgrounds.
  // Content drags, inputs, clicks, scrolling, and portals are untouched.
  useEffect(() => {
    const onSelectStart = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('input, textarea, [contenteditable="true"]')) return;
      if (target.closest("button, select")) return;
      if (!target.closest("[data-no-select-start]")) return;
      if (
        target.closest(
          "p, pre, code, span, a, h1, h2, h3, h4, h5, h6, li, ul, ol, dt, dd, td, th, label, blockquote, [data-selectable]",
        )
      )
        return;
      event.preventDefault();
    };
    document.addEventListener("selectstart", onSelectStart);
    return () => document.removeEventListener("selectstart", onSelectStart);
  }, []);

  useEffect(() => {
    if (appOpenedSentRef.current) {
      return;
    }

    captureAnalyticsEvent("app_opened");
    appOpenedSentRef.current = true;
  }, []);

  useEffect(() => {
    loadSettings()
      .catch(() => {
        captureAnalyticsEvent("settings_load_failed", {
          failure_kind: "settings_load_failed",
          failure_stage: "load_settings",
        });
      })
      .finally(() => {
        setSettingsReady(true);
      });
  }, []);

  useEffect(() => {
    if (!updatesEnabled) return;
    if (!settingsReady || hasCheckedForUpdateThisLaunch) return;

    setHasCheckedForUpdateThisLaunch(true);
    void updater.checkForUpdates({ silent: true });
  }, [settingsReady, hasCheckedForUpdateThisLaunch, updatesEnabled]);

  useEffect(() => {
    if (
      !shouldCaptureFirstRun({
        settingsReady,
        appState,
        analyticsEnabled: isAnalyticsEnabled(),
        firstRunAlreadySent: firstRunSentRef.current || hasSentFirstRun(),
      })
    ) {
      return;
    }

    captureAnalyticsEvent("first_run");
    markFirstRunSent();
    firstRunSentRef.current = true;
  }, [appState, settingsReady]);

  const handleGetStarted = () => {
    // Every user reaches model upload without first preparing a
    // global runtime. Provider and route setup happens on demand.
    setAppState("export");
  };

  let content: ReactNode;

  if (appState === "landing") {
    content = (
      <LandingScreen
        onGetStarted={handleGetStarted}
        settingsReady={settingsReady}
        onOpenAbout={() => setAboutOpen(true)}
        updateAvailable={updater.state === "available"}
      />
    );
  } else {
    content = (
      <ExportWorkspace
        onOpenAbout={() => setAboutOpen(true)}
        updateAvailable={updater.state === "available"}
        onBack={() => setAppState("landing")}
      />
    );
  }

  return (
    <SetupTaskProvider>
      <TitleBarFill />
      <AboutDialog
        open={aboutOpen}
        updatesEnabled={updatesEnabled}
        updater={updater}
        onOpenChange={setAboutOpen}
      />
      {updatesEnabled ? (
        <UpdateDialog
          open={updater.dialogOpen}
          updater={updater}
          onOpenChange={updater.setDialogOpen}
        />
      ) : null}
      {content}
      <SetupActivityBarHost />
    </SetupTaskProvider>
  );
}

export default App;
