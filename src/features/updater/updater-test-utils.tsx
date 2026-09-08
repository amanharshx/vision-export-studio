import type { ReactNode } from "react";
import * as updaterRealModule from "./use-updater-controller";

// Shared test-only helpers. Production code must never import this module.
//
// Bun shares module mocks across test files in one process, so both
// app-launch.test.tsx and update-dialog.test.tsx define their dialog mocks
// and real-module capture here, once, instead of duplicating the shape.
export function ensureRealUpdaterModule(): typeof updaterRealModule {
  const store = globalThis as Record<string, unknown>;
  if (!store.__realUpdaterModule) {
    store.__realUpdaterModule = { ...updaterRealModule };
  }
  return store.__realUpdaterModule as typeof updaterRealModule;
}

export type OverlayMockProps = {
  open?: boolean;
  children?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  showCloseButton?: boolean;
  [key: string]: unknown;
};

// Radix Dialog/Sheet portals never mount under happy-dom, so no overlay UI
// can open in client-rendered tests. These faithful passthroughs preserve the
// open contract (closed renders nothing, open renders children inline) while
// leaving every other UI module untouched.
export function mockOverlayModules() {
  const passthrough = ({ children }: OverlayMockProps) => <>{children}</>;
  const root = ({ open, children }: OverlayMockProps) => (open ? <>{children}</> : null);
  const content = ({ children, showCloseButton }: OverlayMockProps) => (
    <div role="dialog">
      {children}
      {showCloseButton ? (
        <button type="button" aria-label="Close">
          Close
        </button>
      ) : null}
    </div>
  );
  const overlay = () => null;
  const title = ({ children }: OverlayMockProps) => <h2>{children}</h2>;
  const description = ({ children }: OverlayMockProps) => <p>{children}</p>;
  const section = ({ children }: OverlayMockProps) => <div>{children}</div>;
  return { passthrough, root, content, overlay, title, description, section };
}
