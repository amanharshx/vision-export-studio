import { useEffect, useState } from "react";
import { ExportWorkspace } from "@/features/export/export-workspace";
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

type AppState = "booting" | "setup" | "ready";

function App() {
  const [appState, setAppState] = useState<AppState>("booting");
  const [runtimeDir, setRuntimeDir] = useState<string>("");
  const [started, setStarted] = useState(false);

  useEffect(() => {
    loadSettings()
      .then((settings) => {
        setRuntimeDir(settings.runtime_dir);
        if (settings.setup_complete) {
          setAppState("ready");
        } else {
          setAppState("setup");
        }
      })
      .catch(() => {
        // If settings cannot be loaded at all, fall through to setup
        // so the user can configure the runtime directory.
        setAppState("setup");
      });
  }, []);

  if (appState === "booting") {
    // Minimal blank loading state while reading settings.
    return <div className="min-h-screen bg-background" />;
  }

  if (appState === "setup") {
    return (
      <>
        <TitleBarFill />
        <SetupScreen
          defaultRuntimeDir={runtimeDir}
          onComplete={() => setAppState("ready")}
        />
      </>
    );
  }

  // appState === "ready"
  if (!started) {
    return (
      <>
        <TitleBarFill />
        <LandingScreen onGetStarted={() => setStarted(true)} />
      </>
    );
  }

  return (
    <>
      <TitleBarFill />
      <ExportWorkspace onBack={() => setStarted(false)} />
    </>
  );
}

export default App;
