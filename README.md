# HuAHua Device Runtime

Private, local-network-first runtime for letting a user's AI safely control a
device on which the Agent App is installed.

This repository intentionally contains no model provider integration, cloud
control plane, user test assets, or API keys. It is split into portable
protocol contracts, platform runtimes, and thin platform Agent Apps.

## Modules

- `contracts`: Kotlin/JVM portable device command and receipt contract.
- `android-runtime`: Android implementation boundary for self-device control.
- `agent-app`: minimal Android pairing/status shell.

The first milestone is Android-first, while the `contracts` module stays free
of Android APIs so iOS and desktop adapters can adopt the same protocol later.
