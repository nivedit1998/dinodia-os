function stepUpDescriptorDigest(device) {
  const value = device?.presentation?.sourceFingerprint ?? device?.presentation?.descriptorDigest ?? null;
  if (value == null) return null;
  const digest = String(value);
  const prefixed = /^sha256:([0-9a-f]{64})$/.exec(digest);
  if (prefixed) return prefixed[1];
  return /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

module.exports = { stepUpDescriptorDigest };
