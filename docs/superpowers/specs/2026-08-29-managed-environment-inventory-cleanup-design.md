# Managed Environment Inventory and Cleanup

## Goal

Split managed-environment work into two reviewable branches. Branch one adds read-only inventory and logical sizes. Branch two adds safe deletion and UI cleanup controls. Existing `feat/environment-cleanup` remains behavioral reference only.

## Branch 1: inventory

Centralize RF-DETR virtual-environment paths behind `stack_venv_dir_for_key`. Add Rust scan results, trusted presence checks, logical byte scanning without following symlink directories, `spawn_blocking`, and a successful-result session cache with targeted invalidation. Expose scans through Tauri and keep frontend inventory state in one hook with lazy provider scans and generation protection against stale results. Environment cards show scan, calculating, estimate, unavailable, or missing states. No deletion behavior enters this branch.

Install, setup, and rebuild flows only invalidate affected inventory entries after filesystem mutation attempts. Frontend and Rust use identical managed-key policy.

## Branch 2: cleanup

Stack cleanup branch on inventory. Frontend sends managed keys only; Rust resolves exact known paths, validates root/components/targets for containment and symlinks before mutation, holds the cleanup runtime-operation guard through report construction, and returns partial structured results. Failed deletions never report size estimates. Bulk RF-DETR cleanup expands only existing known stacks and preserves unrelated files/settings.

Cleanup UI uses the same provider-to-key mapping as scans, a structured destructive confirmation dialog, and post-delete inventory/dependency refresh. Unknown size or auxiliary presence-scan failure does not block deletion. Existing setup behavior remains unchanged, including truthful Ultralytics reset behavior. Provider-aware runtime readiness remains deferred.

## Verification

Use temporary runtime roots for Rust tests. Run frontend lint/tests/build, Rust format/clippy/tests, Python helper tests, diff checks, and branch audits. Do not touch the real user runtime, push, merge, open PRs, or modify the reference worktree.
