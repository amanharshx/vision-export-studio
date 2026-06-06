# Contributing to YOLO Export Studio

Thank you for considering a contribution! Whether you're fixing a bug, adding a new export route, or improving documentation - your help makes this project better for everyone.

## Bug Reports

Found a bug? Please [open an issue](https://github.com/amanharshx/yolo-export-studio/issues/new) and include:

- **OS and version** (e.g. macOS 15.2, Windows 11, Ubuntu 24.04)
- **App version** (shown in the title bar or About screen)
- **Steps to reproduce** the issue
- **Expected vs actual behavior**
- Sample model or export route details, if relevant

## Feature Requests

Have an idea? [Open a feature request](https://github.com/amanharshx/yolo-export-studio/issues/new) describing:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

## Development Setup

### Prerequisites

| Tool | Install |
|------|---------|
| Rust (stable) | [rustup.rs](https://rustup.rs/) |
| Bun | [bun.sh](https://bun.sh/) |
| Tauri v2 CLI | [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |

### Commands

```bash
# Install frontend dependencies
bun install

# Start development server
bun run tauri dev

# Type-check and build frontend
bun run build

# Frontend type-check only
bun run lint

# Run Rust tests
cd src-tauri && cargo test

# Lint Rust code
cd src-tauri && cargo clippy

# Build release binary
bun run tauri build
```

## Pull Request Process

1. **Fork** the repository and clone your fork
2. **Create a branch** from `main`:
   ```bash
   git checkout -b feat/my-feature
   ```
3. **Make your changes** and test locally with `bun run tauri dev`
4. **Run checks** before committing:
   ```bash
   bun run build                   # frontend type-check + build
   bun run lint                    # frontend type-check only
   cd src-tauri && cargo clippy    # Rust lints
   cd src-tauri && cargo test      # Rust tests
   ```
5. **Commit** with a clear, descriptive message
6. **Push** your branch and [open a pull request](https://github.com/amanharshx/yolo-export-studio/compare) against `main`

## Code Style

- **TypeScript** - Strict mode is enabled. Fix all type errors before submitting.
- **Rust** - Use stable Rust. Run `cargo fmt` and `cargo clippy` before committing. Warnings should be resolved.
- **Commits** - Use clear, imperative-tense messages (e.g. "Add OpenVINO export route help text").

## First-Time Contributors

New to the project? Look for issues tagged [`good first issue`](https://github.com/amanharshx/yolo-export-studio/labels/good%20first%20issue) - these are scoped, well-documented tasks that make a great starting point.

Welcome aboard!
