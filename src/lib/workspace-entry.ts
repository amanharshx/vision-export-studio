// Ticket 12: Open the workspace without a global runtime.
//
// Get Started opens model upload regardless of provider environment inventory
// or legacy setup state. Provider and route setup happens only when the
// selected export requires it. The legacy saved setup field stays readable
// (see AppSettings.setup_complete) but is ignored for navigation until its
// contract ticket removes it.

export type WorkspaceEntryState = "export";

export interface WorkspaceEntryInventory {
  setupComplete?: boolean;
  ultralyticsExists?: boolean | null;
  rfdetrCount?: number;
}

/**
 * Resolve where Get Started goes. Always the workspace (model upload):
 * no-environment, Ultralytics-only, RF-DETR-only, and both-provider states
 * all open the same upload view, on fresh launch and on restart.
 */
export function resolveWorkspaceEntryState(
  _inventory?: WorkspaceEntryInventory | null,
): WorkspaceEntryState {
  return "export";
}
