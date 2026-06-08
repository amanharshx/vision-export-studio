import { type ReactNode, useEffect, useRef, useState } from "react";
import { ExportWorkspace } from "@/features/export/export-workspace";
import { UpdateAnnouncement } from "@/features/updater/update-announcement";
import { useUpdaterController } from "@/features/updater/use-updater-controller";
import { LandingScreen } from "@/features/landing-screen";
import { SetupScreen } from "@/features/setup/setup-screen";
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

type AppState = "landing" | "setup" | "export";

function App() {
  const updatesEnabled = !import.meta.env.DEV;
  const [appState, setAppState] = useState<AppState>("landing");
  const [runtimeDir, setRuntimeDir] = useState<string>("");
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
        setRuntimeDir(settings.runtime_dir);
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
    if (setupComplete) {
      setAppState("export");
    } else {
      setAppState("setup");
    }
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
  } else if (appState === "setup") {
    content = (
      <SetupScreen
        defaultRuntimeDir={runtimeDir}
        updatesEnabled={updatesEnabled}
        updater={updater}
        onComplete={() => {
          setSetupComplete(true);
          setAppState("export");
        }}
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
    <>
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
    </>
  );
}

export default App;
