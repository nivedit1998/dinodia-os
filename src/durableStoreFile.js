const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const INITIALIZED_MARKER_SUFFIX = ".initialized";
const PREVIOUS_SUFFIX = ".previous";
const RESTORE_PENDING_SUFFIX = ".restore-pending";

function codedError(message, code, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

function assertRegularFileSync(filePath, label) {
  let info;
  try { info = fs.lstatSync(filePath); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw codedError(`${label} must be a regular, non-symlink file`, "store_file_type_invalid");
  return info;
}

function syncDirectorySync(directory) {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
}

function ensureInitializedMarkerSync(filePath) {
  const markerPath = `${filePath}${INITIALIZED_MARKER_SUFFIX}`;
  const existing = assertRegularFileSync(markerPath, "Store initialization marker");
  if (existing) {
    if (fs.readFileSync(markerPath, "utf8") !== "dinodia-store-initialized-v1\n") {
      throw codedError("Store initialization marker has an unsupported or invalid format", "store_marker_invalid");
    }
    return;
  }
  const temporaryPath = `${markerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(descriptor, "dinodia-store-initialized-v1\n", "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporaryPath, markerPath);
    syncDirectorySync(path.dirname(filePath));
  } catch (error) {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporaryPath); } catch { /* preserve original failure */ }
    throw error;
  }
}

function hasInitializedMarkerSync(filePath) {
  const markerPath = `${filePath}${INITIALIZED_MARKER_SUFFIX}`;
  const marker = assertRegularFileSync(markerPath, "Store initialization marker");
  if (!marker) return false;
  if (fs.readFileSync(markerPath, "utf8") !== "dinodia-store-initialized-v1\n") {
    throw codedError("Store initialization marker has an unsupported or invalid format", "store_marker_invalid");
  }
  return true;
}

function assertNoRestorePendingSync(filePath) {
  const pendingPath = `${filePath}${RESTORE_PENDING_SUFFIX}`;
  const pending = assertRegularFileSync(pendingPath, "Store restore transaction marker");
  if (!pending) return;
  const contents = fs.readFileSync(pendingPath, "utf8");
  if (!contents.startsWith("dinodia-store-restore-v1\n")) {
    throw codedError("Store restore transaction marker is malformed; refusing to load mutable state", "store_restore_marker_invalid");
  }
  throw codedError("A Store/vault restore transaction is incomplete; keep Native OS stopped and follow the recovery evidence", "store_restore_pending");
}

function validateStoreFileSync(filePath) {
  const stat = assertRegularFileSync(filePath, "Native OS store");
  if (!stat) return null;
  let value;
  try { value = JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch (error) { throw codedError("Existing Native OS store is not valid JSON; refusing to replace it", "store_existing_invalid", error); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("Existing Native OS store is not a JSON object; refusing to replace it", "store_existing_invalid");
  }
  return stat;
}

async function syncDirectory(directory, beforeSync = null) {
  const handle = await fs.promises.open(directory, "r");
  try {
    if (beforeSync) await beforeSync(directory);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeBytesAtomically(filePath, bytes, { mode = 0o600, beforeDirectorySync = null } = {}) {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let handle;
  let renamed = false;
  try {
    handle = await fs.promises.open(temporaryPath, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, filePath);
    renamed = true;
    await syncDirectory(directory, beforeDirectorySync);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
    if (renamed) {
      throw Object.assign(codedError("Store rename completed but directory durability could not be confirmed", "store_durability_uncertain", error), { committed: true });
    }
    throw error;
  }
}

async function persistStoreJson(filePath, serialized, { beforeDirectorySync = null } = {}) {
  const directory = path.dirname(filePath);
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const current = validateStoreFileSync(filePath);
  ensureInitializedMarkerSync(filePath);

  if (current) {
    const previousPath = `${filePath}${PREVIOUS_SUFFIX}`;
    assertRegularFileSync(previousPath, "Previous Native OS store generation");
    const previousTemp = `${previousPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      // A hard link preserves the last fully committed generation without
      // copying the whole Store on every write or increasing SD-card writes.
      await fs.promises.link(filePath, previousTemp);
      await fs.promises.rename(previousTemp, previousPath);
      await syncDirectory(directory, beforeDirectorySync);
    } catch (error) {
      await fs.promises.unlink(previousTemp).catch(() => {});
      throw error;
    }
  }

  await writeBytesAtomically(filePath, Buffer.from(serialized, "utf8"), { mode: 0o600, beforeDirectorySync });
}

module.exports = {
  INITIALIZED_MARKER_SUFFIX,
  PREVIOUS_SUFFIX,
  RESTORE_PENDING_SUFFIX,
  assertNoRestorePendingSync,
  ensureInitializedMarkerSync,
  hasInitializedMarkerSync,
  persistStoreJson,
  validateStoreFileSync,
  writeBytesAtomically,
};
