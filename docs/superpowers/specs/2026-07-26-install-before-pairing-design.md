# Install-Before-Pairing Design

## Goal

Make first-time setup predictable: the computer finishes preparing HuAHua before it asks the
phone to approve pairing, the approved MCP process immediately maintains its live connection, and
the AI waits for the phone-control environment to become ready before requesting a screenshot.

## Setup state machine

1. `prepare`: verify Node/package execution and create or load the computer's local P-256 identity.
2. `pairing`: only after preparation succeeds, consume the short-lived connection card and ask the
   user to approve the named computer.
3. `phone_setup`: after approval, keep the MCP process and heartbeat alive while HuAHua guides the
   user through the required phone-side setup.
4. `ready`: `device_status` reports that phone control is ready. Only then may the AI call
   `device_observe` and action tools.

The recommended MCP entrypoint is `connect <connection_card>` because it pairs and then continues
as the same stdio MCP process. The one-shot `pair` command remains available for terminal-only
clients, but documentation must not present it as the preferred MCP setup path.

## Protocol

The phone health response exposes `phone_control_ready` without exposing implementation-specific
service names. MCP `device_status` maps this to:

- `phone_setup_required`: computer pairing and heartbeat are live, but phone setup is incomplete.
- `connected`: pairing, heartbeat, and phone control are all ready.
- `reconnecting`: the trusted phone is temporarily undiscoverable.

`device_observe` refuses early with a Chinese `phone_setup_required` response rather than attempting
screen capture.

## Documentation and safety

README and bundled Skill instructions must require preparation before pairing and explicitly forbid
screen observation before `device_status` becomes `connected`. Connection cards remain local,
short-lived secrets and are never persisted.

## Verification

- Node tests cover `prepare`, readiness mapping, and early observation refusal.
- Android unit tests cover the health readiness field.
- Run the full MCP test suite, Android Kotlin compilation, relevant Android unit tests, and
  `git diff --check` in both repositories.
