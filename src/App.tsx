import { useState } from "react";
import { ExportWorkspace } from "@/features/export/export-workspace";
import { LandingScreen } from "@/features/landing-screen";

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

function App() {
  const [started, setStarted] = useState(false);

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
