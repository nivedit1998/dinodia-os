# Native updater trust provisioning

The updater remains disabled until an authorised organisational release authority is approved. This procedure installs only a public Ed25519 key and bounded release policy on the existing enrolled Pi. The private signing key must remain in the organisation-approved signer/HSM or other approved off-device custody. Never copy private signing material to the Pi, repository, browser, chat, or runtime environment; never reuse the manufacturing key.

## Approval inputs

Before creating a policy candidate, the owner/security approver must identify and approve all of the following from an existing organisational authority or an explicitly approved new one:

- Immutable `signingKeyId` and the public-key SHA-256 fingerprint.
- Public Ed25519 SPKI PEM only.
- Exact lowercase artifact hostname allowlist and the `stable` channel.
- Off-device private-key custody, authorised signers, rotation/revocation owner, and recovery contact.
- Exact candidate policy SHA-256 after local inspection.

The runtime target is fixed to `aarch64`, updater API version `2`, and the installed store schema version. The maximum manifest lifetime, download timeout and free-space minimum must remain within `loadRootPolicy`'s bounds. Do not approve a wildcard hostname, URL path, IP address, redirect host, test key, personal key, or a key whose provenance/custody is unknown. If no approved authority exists, stop before provisioning and obtain the organisation's key-management decision; do not silently create production trust.

## Prepare and inspect the public-only policy on the Mac

Create `updater-policy.json` in an owner-controlled, access-restricted directory from the already-approved public key. The candidate builder accepts only an Ed25519 public-key PEM, a bounded key ID, and exact lowercase DNS artifact hostnames. It fixes the channel to `stable`, target to `aarch64`, API version to `2`, and uses the current source's `NATIVE_AUTOMATION_STORE_VERSION`; do not copy an old schema number blindly. It never generates a key or accesses private signing material.

Build the candidate locally from the Dinodia OS repository, substituting only the real, independently approved public-key file, key ID, exact host allowlist, and owner-controlled output path:

```bash
cd "/Users/niveditgupta/Documents/Dinodia Smart Living/Tech Stack V2/Dinodia OS"
umask 077
node scripts/create-updater-policy-candidate.js \
  --public-key "/absolute/owner-controlled/path/approved-release-public.pem" \
  --key-id APPROVED_ORG_KEY_ID \
  --artifact-host APPROVED_EXACT_LOWERCASE_HOST \
  --output "/absolute/owner-controlled/path/updater-policy.json"
```

The builder prints only the policy digest, public-key fingerprint, key ID, channel and artifact hostnames. Independently compare all of them with the organisational approval record. Then re-inspect the candidate with `node scripts/provision-updater-trust.js --inspect yes --candidate "/absolute/owner-controlled/path/updater-policy.json"`. The approved digest is an explicit confirmation that the exact reviewed bytes—not merely a key label—are authorised. Keep the private key outside this file and outside the Pi.

## Rediscover and install on the existing Pi

Follow `Testing_furtureproofed_info.md` §3 each time: rediscover the current same-LAN Pi address, verify its saved SSH host identity, and check the installed build/services before acting. Do not use a historical IP as identity. Transfer only the reviewed public policy and the two reviewed provisioning-tool source files; use the guide's two-step Mac SSH then Pi-root procedure, entering sudo locally. Never pipe commands into a password prompt.

The provisioner expects the installed, protected updater service at `/usr/lib/dinodia-os-updater/current/src/updater/service.js`; it uses that installed service's policy validator. In the Pi root shell, create a fresh staging directory and install the transferred files and policy with root ownership and restrictive modes, preserving the existing `/etc/dinodia-os/updater-policy.json` until explicit apply:

```bash
set -Eeuo pipefail
umask 077
stage="$(mktemp -d /tmp/dinodia-updater-trust.XXXXXX)"
install -d -o root -g root -m 0700 "$stage/scripts" "$stage/src/updater"
install -o root -g root -m 0500 /home/dinodia/provision-updater-trust.js "$stage/scripts/provision-updater-trust.js"
install -o root -g root -m 0500 /home/dinodia/trustProvisioning.js "$stage/src/updater/trustProvisioning.js"
install -o root -g root -m 0400 /home/dinodia/updater-policy.json "$stage/updater-policy.json"
node "$stage/scripts/provision-updater-trust.js" --inspect yes --candidate "$stage/updater-policy.json"
```

The Pi-side inspection must report the same approved SHA-256 and public-key fingerprint as the Mac-side review. Stop on any mismatch. Only after the owner has approved that exact digest, apply it by substituting the approved 64-character hex digest below:

```bash
node "$stage/scripts/provision-updater-trust.js" --apply yes \
  --candidate "$stage/updater-policy.json" \
  --approve-sha256 APPROVED_POLICY_SHA256
systemctl is-active dinodia-os-updater.service
```

The provisioner makes a root-owned `0600` backup of the old policy, atomically installs a root-owned `0600` candidate, restarts only `dinodia-os-updater.service`, and requires the bounded control socket to report `trustState:"ready"`. Its output identifies the backup path and public policy/key digests only. The OS release, pairing, identity, store, Cloudflare tunnel, and Pi address are not changed. No OS reinstall or Vercel deployment is part of this policy-only operation.

## Roll back the policy

If provisioning does not confirm ready, the tool restores the previous policy and restarts the updater automatically. For a later owner-directed rollback, use the exact `backupPath` printed by the successful apply (do not guess or select a different file):

```bash
set -Eeuo pipefail
install -o root -g root -m 0600 "/var/lib/dinodia-os-updater/trust-backups/EXACT_REPORTED_BACKUP" \
  /etc/dinodia-os/updater-policy.json
systemctl restart dinodia-os-updater.service
node -e 'const n=require("node:net");let b="";const s=n.createConnection("/run/dinodia-os-updater/control.sock");s.setTimeout(5000,()=>process.exit(1));s.on("connect",()=>s.end(JSON.stringify({operation:"status"})+"\n"));s.on("data",c=>{b+=c.toString();const i=b.indexOf("\n");if(i<0)return;const r=JSON.parse(b.slice(0,i));process.stdout.write(JSON.stringify({ok:r.ok,trustState:r.status&&r.status.trustState})+"\n");process.exit(r.ok&&r.status&&r.status.trustState==="unprovisioned"?0:1)})'
```

Confirm the old policy's reported digest/backup identity and `trustState:"unprovisioned"`. Do not delete the protected backup or the Pi's existing release/installer rollback artifacts as part of routine cleanup.

## Scope of evidence

Maintained disposable tests exercise public-only key validation, digest mismatch, symlink/private-key rejection, atomic installation and backup, failed restart/status restoration, the exact bounded restart command, status-only socket request, and fail-closed non-ready status. They use disposable test keys and do not provision or establish Production signing authority. The production trust checkpoint passes only after the organisation's real authority/custody is approved, the public-only policy is provisioned on the existing Pi, and the installed service reports `ready` with identity/tunnel/build unchanged. Test-key success is not production-key evidence.
