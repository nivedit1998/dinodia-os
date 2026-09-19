#!/usr/bin/env node
"use strict";

const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const config = require("../src/config");
const { SecretVault } = require("../src/secretVault");
const { Store } = require("../src/store");
const { GoogleNestCredentialProvider } = require("../src/integrations/googleNest/oauthCredentialProvider");

function hiddenQuestion(prompt) {
  return new Promise((resolve, reject) => {
    stdout.write(prompt);
    if (typeof stdin.setRawMode !== "function") return reject(new Error("A TTY with hidden input support is required"));
    let value = "";
    const onData = (chunk) => {
      const key = String(chunk);
      if (key === "\u0003") { cleanup(); reject(new Error("Cancelled")); return; }
      if (key === "\r" || key === "\n") { cleanup(); stdout.write("\n"); resolve(value); return; }
      if (key === "\u007f") { value = value.slice(0, -1); return; }
      if (!key.startsWith("\u001b")) value += key;
    };
    const cleanup = () => { stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function main() {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Google Nest credential setup requires an interactive terminal");
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const project = (await rl.question("Google Device Access project ID: ")).trim();
    const clientId = (await rl.question("Google OAuth client ID: ")).trim();
    const clientSecret = (await hiddenQuestion("Google OAuth client secret: ")).trim();
    const savedCloudflare = new Store(config.dataFile).getCloudflare?.() || {};
    const hostname = String(config.cloudflarePublicHostname || savedCloudflare.hostname || "").trim();
    if (!hostname || !/^https?:\/\//i.test(hostname) && !/^[a-z0-9.-]+$/i.test(hostname)) throw new Error("Configure CLOUDFLARE_PUBLIC_HOSTNAME before storing Google Nest credentials");
    const host = hostname.replace(/^https?:\/\//i, "").replace(/\/$/, "");
    const redirectUri = `https://${host}${config.googleNestCallbackPath}`;
    const provider = new GoogleNestCredentialProvider({ vault: new SecretVault({ dataDir: config.dataDir }) });
    await provider.saveDeveloper({ deviceAccessProjectId: project, oauthClientId: clientId, oauthClientSecret: clientSecret, registeredRedirectUri: redirectUri, releaseChannel: config.googleNestReleaseChannel || "sandbox_beta" });
    console.log(`Google Nest developer credentials stored securely. Callback: ${redirectUri}`);
  } finally {
    rl.close();
  }
}

main().catch((error) => { console.error(`Google Nest setup failed: ${error.message}`); process.exitCode = 1; });
