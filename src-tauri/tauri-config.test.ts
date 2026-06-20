// @ts-expect-error Bun provides this module at test runtime.
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

const POSTHOG_INGESTION_HOSTS = ["https://us.i.posthog.com", "https://eu.i.posthog.com"];

function readTauriConfig() {
  return JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")) as {
    app?: {
      security?: {
        csp?: string;
      };
    };
  };
}

describe("tauri production CSP", () => {
  it("allows PostHog ingestion requests", () => {
    const csp = readTauriConfig().app?.security?.csp ?? "";

    expect(csp).toContain("connect-src");
    for (const host of POSTHOG_INGESTION_HOSTS) {
      expect(csp).toContain(host);
    }
  });
});

describe("release workflow", () => {
  it("keeps PostHog host validation aligned with CSP", () => {
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");

    for (const host of POSTHOG_INGESTION_HOSTS) {
      expect(workflow).toContain(host);
    }
    expect(workflow).toContain("not in Tauri CSP connect-src allowlist");
  });
});
