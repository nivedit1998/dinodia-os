# Hive security and privacy

## Credential boundary

The dashboard accepts Hive credentials only through an authenticated admin route. In production the credential and SMS routes require the configured HTTPS Cloudflare hostname (or loopback for a local operator). Plain LAN HTTP, an unrelated Origin, and missing admin authentication are rejected. Request bodies remain bounded and are not cached by the browser.

Node starts one unprivileged Python worker. The worker communicates over bounded NDJSON and exposes only allow-listed operations and sanitized DTOs. It never writes upstream responses to stdout. The Node bridge validates response IDs, protocol versions, message size, timeouts, restart counts, and circuit-breaker state.

## Storage and logging

Hive username, password, access/refresh tokens, and client-registration material are stored only as one AES-256-GCM encrypted `SecretVault` record keyed to the local machine key. The JSON store contains only masked account/status metadata, HMAC account identity, stable cloud-ID-derived device identities, counts, assignments, and tombstones. Activity, worker diagnostics, API errors, backups, support bundles, and platform heartbeat payloads are redacted or exclude credentials, MFA codes, tokens, and raw Hive payloads.

## Threat model

The implementation assumes the Hive consumer API is unofficial and may change or be unavailable. It therefore fails closed on unknown products and commands, preserves the native Hive app and schedules, does not touch the Zigbee radio, and degrades only the Hive integration. One hub accepts one account in version 1; a different account requires explicit disconnect. A removed device remains tombstoned until explicit restore or account disconnect.

The machine key and vault are owner-readable only. The worker source and venv are read-only after installation. The service adds no public port and does not expose Hive, MQTT, Matter Server, OTBR, or the worker directly to the internet; Cloudflare is the remote entry point and the admin token is still required.

## Security checks

Verify with the automated suite that nested secrets are absent from status, logs, activity, backups' plaintext envelope, support bundles, platform snapshots, and API errors. Also verify credential routes reject insecure transport and wrong origins, setup sessions expire, repeated failures enter cooldown, worker output is bounded, and disconnect clears the encrypted vault record.

## Google Nest OAuth boundary

Google Nest uses the official SDM Partner Connections Manager flow. Dinodia OS never collects a Google password and requests only the `sdm.service` scope. The OAuth callback is one exact HTTPS Cloudflare route protected by a high-entropy, one-use, ten-minute state value; it rejects wrong hosts, replayed state, oversized query values, and arbitrary redirect data. The callback page is no-store, frame-denied, referrer-free, and contains no token or device payload.

The operator's Device Access client credentials and each customer's refresh token are separate AES-256-GCM vault records. Access tokens stay in memory and are refreshed before expiry. The store, logs, Activity, heartbeat, diagnostics, browser storage, and support output contain only sanitized status, counts, and local HMAC identifiers. Pilot hubs hold the client secret locally; this is an explicitly documented Sandbox-beta limitation and blocks broad rollout until an approved central OAuth broker is available.
## Native automation security boundary

Native automation requests remain behind the authenticated Dinodia OS
dashboard/admin namespace. Request JSON cannot choose its own owner, home, or
device scope; the server supplies a trusted local-admin context, while the
service accepts narrower future scopes for platform-mediated tenant access.

The action catalogue is generated from current writable Dinodia capabilities.
It exposes only explicitly allowed, bounded services. Boolean actions compile
to explicit on/off operations rather than toggles. Unlock, reset, remove,
pairing, configuration, and other destructive services are excluded. Device
and control routes are resolved again immediately before execution so a stale
stored display name or route cannot bypass current capability policy.

Definitions and history store stable IDs, typed values, and sanitized error
codes only. Credentials, bearer tokens, raw protocol payloads, request headers,
and stack traces are not accepted as automation data or written to Activity.
