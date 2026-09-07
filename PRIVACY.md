# Privacy

Vision Export Studio uses PostHog for install-scoped pseudonymous usage analytics.

The app stores a persistent install identifier locally so launches and lifecycle events from the same install can be measured across sessions. This is not tied to a user account, but it is not purely anonymous telemetry either.

Current analytics covers product usage events such as:

- app launches
- environment setup results (provider, environment key, route ID, success or failure, and setup duration)
- export started, completed, failed, and cancelled
- app and device metadata such as app version, OS, architecture, install channel, and route/event metadata

Analytics does **not** collect:

- model files
- model paths or filenames
- checkpoint metadata
- dataset contents
- file contents
- export logs
- package logs
- local file paths
- Python paths or output paths
- raw error text
- personal identity such as email address or username

Exports still run locally on your machine. Analytics is limited to install-scoped product telemetry about app usage and app/device metadata, not model or dataset contents.
