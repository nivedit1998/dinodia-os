const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

test("production operator public-key configuration decodes escaped PEM newlines", () => {
  const keys = crypto.generateKeyPairSync("ed25519");
  const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const previous = process.env.DINODIA_OPERATOR_PUBLIC_KEY;
  process.env.NODE_ENV = "production";
  process.env.DINODIA_OPERATOR_PUBLIC_KEY = pem.trim().replaceAll("\n", "\\n");
  delete require.cache[require.resolve("../src/config")];
  const { config } = (() => {
    const loaded = require("../src/config");
    return { config: loaded.config || loaded };
  })();
  assert.equal(config.operatorPublicKey, pem.trim());
  assert.equal(crypto.createPublicKey(config.operatorPublicKey).asymmetricKeyType, "ed25519");
  if (previous === undefined) delete process.env.DINODIA_OPERATOR_PUBLIC_KEY;
  else process.env.DINODIA_OPERATOR_PUBLIC_KEY = previous;
});
