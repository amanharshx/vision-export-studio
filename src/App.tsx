import { type ReactNode, useEffect, useRef, useState } from "react";
import { ExportWorkspace } from "@/features/export/export-workspace";
import { UpdateAnnouncement } from "@/features/updater/update-announcement";
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
  // Ticket 15: the retired global setup flag is gone. Navigation and
  // readiness are inventory-driven; only settings load gates first-run and
  // update checks.
  const [settingsReady, setSettingsReady] = useState(false);
  const [hasCheckedForUpdateThisLaunch, setHasCheckedForUpdateThisLaunch] = useState(false);
  const appOpenedSentRef = useRef(false);
  const firstRunSentRef = useRef(false);
  const updater = useUpdaterController();

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
    // Ticket 12: every user reaches model upload without first preparing a
    // global runtime. Provider and route setup happens on demand.
    setAppState("export");
  };

  const showUpdateAnnouncement =
    updatesEnabled &&
    updater.state === "available" &&
    !updater.hasDismissedAnnouncementThisSession;

  let content: ReactNode;

  if (appState === "landing") {
    content = (
      <LandingScreen
        onGetStarted={handleGetStarted}
        settingsReady={settingsReady}
        updatesEnabled={updatesEnabled}
        updater={updater}
      />
    );
  } else {
    content = (
      <ExportWorkspace
        updatesEnabled={updatesEnabled}
        updater={updater}
        onBack={() => setAppState("landing")}
      />
    );
  }

  return (
    <SetupTaskProvider>
      <TitleBarFill />
      {updatesEnabled ? (
        <UpdateAnnouncement
          open={showUpdateAnnouncement}
          updater={updater}
          onOpenChange={(open) => {
            if (!open) updater.dismissAnnouncement();
          }}
        />
      ) : null}
      {content}
      <SetupActivityBarHost />
    </SetupTaskProvider>
  );
}

export default App;
