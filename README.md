# HuAHua Device Runtime

Local-network-first runtime for letting a user's AI safely control a device on
which the HuAHua app is installed.

This repository intentionally contains no model provider integration, cloud
control plane, user test assets, or API keys. It is split into portable
protocol contracts, platform runtimes, and thin platform Agent Apps.

## Modules

- `contracts`: Kotlin/JVM portable device command and receipt contract.
- `android-runtime`: Android implementation boundary for self-device control.
- `agent-app`: minimal Android pairing/status shell.
- `mcp-bootstrap`: Node.js MCP bridge used by an AI host on the same LAN.

The first milestone is Android-first, while the `contracts` module stays free
of Android APIs so iOS and desktop adapters can adopt the same protocol later.

## AI host connection

HuAHua has two equivalent sharing entries for a phone's first AI-host pairing:

- **Copy for AI** is the reliable entry. It copies a self-describing text card
  containing the setup documentation URL, the MCP package name, and a
  short-lived connection card.
- **QR code** encodes the same text card for a person to scan and forward. An
  AI may be able to read a QR image, but QR image recognition is not a protocol
  requirement; users should paste the decoded text into an AI when possible.

The text card tells a new AI what it is receiving before it sees the private
connection card. It points to the public setup guide in
[`mcp-bootstrap/README.md`](mcp-bootstrap/README.md). The card must not be put
in a GitHub query parameter, browser URL, issue, commit, or log: it is a
short-lived pairing secret.

The first pairing requires a one-time approval on the phone. The Node MCP host
then saves only its local P-256 host key and public device discovery metadata
under `~/.config/huahua-mcp` with user-only permissions. Future connections
discover the phone over mDNS and obtain a new short-lived signed session; they
do not need another QR code or approval unless the user revokes the host,
clears app data, or uses another computer.

## Runtime boundary

This repository is the HuAHua Device Agent runtime. It does not host a cloud
control plane, user test assets, model API keys, raw ADB endpoints, or
arbitrary shell execution. The LAN MCP bridge is deliberately limited to an
approved host, fresh observations, and narrow phone actions; it is not a shell
or an unauthenticated remote-control endpoint.

HuAHua consumes `:android-runtime` through a Gradle composite build during
local development. `AutoGLMShizukuService` remains HuAHua's foreground/UI host,
while its fixed Android actions and the two-phase raw PNG capture delegate to
`ShizukuAndroidDeviceRuntime`. Raw shell remains internal to the runtime; this
does not introduce arbitrary shell access or a second product app.
