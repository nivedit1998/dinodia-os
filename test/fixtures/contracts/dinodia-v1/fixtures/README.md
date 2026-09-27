# Dinodia v1 fixtures

These fixtures use synthetic opaque IDs and UTC timestamps. They are protocol examples, never seeded production data. The `contract.json` document is the canonical versioned source. `multi-control-device` exercises dynamic descriptors and manual-app-only security controls; `tenant-device-wrong-owner` must be omitted/rejected for a non-owner membership; `analytics-unknown-on-expiry` prevents stale telemetry from being treated as Off. Generated consumer copies are synchronized by the Platform contract check.

## Contract test runner exception

The Stage 2 technical register prefers Vitest for Platform/Alexa. This repository intentionally uses the Node built-in test runner for these focused compatibility suites: its existing Stage 1 security suite and clean-clone gate already use `node:test`, and the contract tests must run in that same dependency-isolated gate. Alexa's current test suite also uses `node:test`; adding Vitest to both consumers solely for fixtures would create a second test framework and duplicate runner configuration without improving JSON/semantic compatibility coverage. OS continues to use `node:test`, and iOS uses XCTest. Revisit only if either repository adopts Vitest as its standard runner; do not maintain parallel contract suites.
