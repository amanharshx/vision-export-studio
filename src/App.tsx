import { useEffect, useRef, useState } from "react";
import { ExportWorkspace } from "@/features/export/export-workspace";
import { LandingScreen } from "@/features/landing-screen";
import { SetupScreen } from "@/features/setup/setup-screen";
import {
  captureAnalyticsEvent,
  hasSentFirstRun,
  isAnalyticsEnabled,
  markFirstRunSent,
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
  const [appState, setAppState] = useState<AppState>("landing");
  const [runtimeDir, setRuntimeDir] = useState<string>("");
  const [setupComplete, setSetupComplete] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const appOpenedSentRef = useRef(false);
  const firstRunSentRef = useRef(false);

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

        if (!firstRunSentRef.current && !hasSentFirstRun() && isAnalyticsEnabled()) {
          captureAnalyticsEvent("first_run");
          markFirstRunSent();
          firstRunSentRef.current = true;
        }
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

  const handleGetStarted = () => {
    if (setupComplete) {
      setAppState("export");
    } else {
      setAppState("setup");
    }
  };

  if (appState === "landing") {
    return (
      <>
        <TitleBarFill />
        <LandingScreen onGetStarted={handleGetStarted} settingsReady={settingsReady} />
      </>
    );
  }

  if (appState === "setup") {
    return (
      <>
        <TitleBarFill />
        <SetupScreen
          defaultRuntimeDir={runtimeDir}
          onComplete={() => { setSetupComplete(true); setAppState("export"); }}
        />
      </>
    );
  }

  return (
    <>
      <TitleBarFill />
      <ExportWorkspace onBack={() => setAppState("landing")} />
    </>
  );
}

export default App;
