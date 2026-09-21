# Dinodia OS native V2 foundation reconciliation

This is the foundation-stage classification of the existing Dinodia OS worktree. It does not
claim that the later native provisioning, support, offline authorization or customer journeys are
complete. It records what is retained for the next stage and what is deliberately isolated.

## Boundary

- Dinodia OS will talk only to an explicitly configured Native V2 platform URL.
- No old platform URL is a default or fallback.
- Production configuration forces `legacyCompatibilityEnabled = false` and ignores legacy admin,
  HA and bootstrap environment credentials.
- Home Assistant compatibility code remains only as a development/test compatibility surface until
  its owning numbered Native V2 stage removes it. It is not a production authority path.
- The foundation does not deploy to the Pi or introduce a customer database client.

## File classification

| File/change | Status | Reason and next owner |
|---|---|---|
| `.env.example` | REWORK | Removes old platform/state-change defaults; Stage 1 supplies value-free V2 names. |
| `README.md` | REWORK | Documents native V2 boundary and explicit platform configuration. |
| `docs/operations.md` | REWORK | Retain operating guidance; Stage 1 must replace any old endpoint/runbook references. |
| `package.json` / `package-lock.json` | KEEP | Existing hub runtime and security test dependencies remain reproducible. |
| `public/app.js` / `public/index.html` | KEEP | Native capability/status shell; no routine token input is enabled in production. |
| `scripts/healthcheck.js` | KEEP | Local health helper, no customer authority. |
| `scripts/install-pi.sh` | REWORK | Installer must use Native V2 identity/setup contract, not old platform credentials. |
| `scripts/initialize-identity.js` | KEEP | First-release encrypted identity setup; hardware-backed security is not claimed. |
| `scripts/check-native-v2-boundary.mjs` | KEEP | Automated configuration boundary gate. |
| `src/config.js` | REWORK | Legacy values remain development-only; V2 platform URL now has no old fallback. |
| `src/server.js` | KEEP/DEFER_STAGE_1 | Fail-closed native auth and dynamic dispatch are retained; full cloud contracts belong to Stage 1. |
| `src/auth/**` | KEEP/DEFER_STAGE_1 | Native operator/app/offline/step-up primitives are retained for integration in Stage 1. |
| `src/identityd.js` | KEEP | Root-only encrypted key broker boundary. |
| `systemd/dinodia-identityd.service` | KEEP | Starts the broker with restricted service ownership. |
| `src/setupDiscovery.js` | KEEP/DEFER_STAGE_1 | Installer-only `.local` discovery; final browser pairing contract belongs to Stage 1. |
| `public/setup.html` / `public/setup.js` | KEEP/DEFER_STAGE_1 | Locked setup surface; no dashboard/customer data boundary. |
| `src/platformPairing.js` | REWORK/DEFER_STAGE_1 | Native signed outbound pairing retained; old bootstrap/sync methods are explicitly disabled outside development compatibility. |
| `src/secretVault.js` | REWORK | Retain encrypted local storage; identity private keys must use the broker and not direct app reads. |
| `src/store.js` | REWORK | Preserve local OS state, but Stage 1 must replace old platform payload assumptions. |
| `src/cloudflareTunnel.js` | DEFER_STAGE_1 | Keep local tunnel integration; signed CloudURL and independent Platform verification belong to Stage 1. |
| `src/haCompat.js` / `src/haModel.js` / `src/ha*` | DEFER_STAGE_1 | Development/test compatibility only; not native V2 authority and no production fallback. |
| `src/stateChangeNotifier.js` | REWORK | Remove old endpoint assumption; V2 ingestion contract is a later platform stage. |
| `src/automations/**` | DEFER_STAGE_1 | Existing OS scheduler is retained for later native automation integration; no cloud contract is claimed here. |
| `src/capabilities/**` | KEEP | Dynamic control descriptors are the intended source for later app/automation work. |
| `src/integrations/**` | KEEP/DEFER | Device protocol adapters remain OS-local; customer exposure is later scoped by V2 authorization. |
| `test/stage1-*.test.js` | KEEP | Existing negative production-boundary coverage is preserved. |
| `test/platform-pairing.test.js` / `test/provisioning.test.js` | KEEP/DEFER | Development compatibility tests remain; native signed contract tests belong to Stage 1. |
| `test/**` existing device/integration tests | KEEP | Existing OS regression coverage is not weakened or deleted. |

## Verification commands

```text
npm test
npm run check
npm run check:generated
npm run check:native-v2
```

The check is intentionally not a full Stage 1 pass. It proves only that the foundation has not
silently retained an old platform target or production legacy credential fallback.
