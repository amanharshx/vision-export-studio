import { type ReactNode, useEffect, useState } from "react";
import { ExportWorkspace } from "@/features/export/export-workspace";
import { UpdateAnnouncement } from "@/features/updater/update-announcement";
import { useUpdaterController } from "@/features/updater/use-updater-controller";
import { LandingScreen } from "@/features/landing-screen";
import { SetupScreen } from "@/features/setup/setup-screen";
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
  const [hasCheckedForUpdateThisLaunch, setHasCheckedForUpdateThisLaunch] = useState(false);
  const updater = useUpdaterController();

  useEffect(() => {
    loadSettings()
      .then((settings) => {
        setRuntimeDir(settings.runtime_dir);
        setSetupComplete(settings.setup_complete);
      })
      .catch(() => {})
      .finally(() => {
        setSettingsReady(true);
      });
  }, []);

  useEffect(() => {
    if (!settingsReady || hasCheckedForUpdateThisLaunch) return;

    setHasCheckedForUpdateThisLaunch(true);
    void updater.checkForUpdates({ silent: true });
  }, [settingsReady, hasCheckedForUpdateThisLaunch]);

  const handleGetStarted = () => {
    if (setupComplete) {
      setAppState("export");
    } else {
      setAppState("setup");
    }
  };

  const showUpdateAnnouncement =
    updater.state === "available" && !updater.hasDismissedAnnouncementThisSession;

  let content: ReactNode;

  if (appState === "landing") {
    content = (
        <LandingScreen
          onGetStarted={handleGetStarted}
          settingsReady={settingsReady}
          updater={updater}
        />
      );
  } else if (appState === "setup") {
    content = (
      <SetupScreen
        defaultRuntimeDir={runtimeDir}
        updater={updater}
        onComplete={() => { setSetupComplete(true); setAppState("export"); }}
      />
    );
  } else {
    content = (
      <ExportWorkspace
        updater={updater}
        onBack={() => setAppState("landing")}
      />
    );
  }

  return (
    <>
      <TitleBarFill />
      <UpdateAnnouncement
        open={showUpdateAnnouncement}
        updater={updater}
        onOpenChange={(open) => {
          if (!open) updater.dismissAnnouncement();
        }}
      />
      {content}
    </>
  );
}

export default App;
