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
import { resolveWorkspaceEntryState } from "@/lib/workspace-entry";

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
  // Legacy global setup flag stays readable for analytics and older settings
  // files, but navigation no longer depends on it (ticket 12). Its contract
  // removal belongs to ticket 15.
  const [setupComplete, setSetupComplete] = useState(false);
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
      .then((settings) => {
        setSetupComplete(settings.setup_complete);
      })
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
        setupComplete,
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
  }, [appState, settingsReady, setupComplete]);

  const handleGetStarted = () => {
    // Ticket 12: every user reaches model upload without first preparing a
    // global runtime. Provider and route setup happens on demand.
    setAppState(resolveWorkspaceEntryState({ setupComplete }));
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
        onSetupCompleteChange={(complete) => {
          // Legacy field stays readable but never navigates (ticket 12).
          setSetupComplete(complete);
        }}
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
