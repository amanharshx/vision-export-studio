import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initAnalytics } from "@/lib/analytics";
import "./index.css";

function renderApp() {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

renderApp();

void initAnalytics().catch(() => {});
