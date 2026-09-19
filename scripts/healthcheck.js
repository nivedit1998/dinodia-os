const adminToken = String(process.env.DINODIA_ADMIN_TOKEN || "").trim();
const configuredUrls = String(process.env.DINODIA_HEALTHCHECK_URL || "").trim();
const defaultUrls = [
  "http://127.0.0.1:8123/api/health",
  "http://127.0.0.1:8099/api/health",
  ...(adminToken ? ["http://127.0.0.1:8123/_dinodia/admin/api/health"] : []),
];
const urls = (configuredUrls || defaultUrls.join(","))
  .split(",").map((value) => value.trim()).filter(Boolean);

Promise.all(urls.map((url) => {
  const headers = {};
  if (adminToken && url.includes("/_dinodia/admin/")) headers.authorization = `Bearer ${adminToken}`;
  return fetch(url, { headers }).then(async (response) => {
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = await response.json();
  if (!body.ok) throw new Error(`${url} returned ok=false`);
  return body;
  });
}))
  .then((bodies) => {
    const maxRssMb = Number(process.env.DINODIA_HEALTHCHECK_MAX_RSS_MB || 0);
    const health = bodies.find((body) => body.memory);
    if (health?.storeSchemaVersion && health.storeSchemaVersion < 4) throw new Error(`store schema is too old (${health.storeSchemaVersion})`);
    if (maxRssMb > 0 && health?.memory?.rssMb > maxRssMb) throw new Error(`RSS memory ${health.memory.rssMb} MB exceeds ${maxRssMb} MB`);
    if (process.env.DINODIA_HEALTHCHECK_REQUIRE_MQTT === "true" && !health?.integrations?.mqtt?.connected) throw new Error("MQTT is required but not connected");
    if (process.env.DINODIA_HEALTHCHECK_REQUIRE_MATTER === "true" && !health?.integrations?.matter?.connected) throw new Error("Matter Server is required but not connected");
    if (process.env.DINODIA_HEALTHCHECK_REQUIRE_HIVE === "true" && health?.integrations?.hive?.configured && health.integrations.hive.status !== "connected") throw new Error("Hive is required but not connected");
    if (process.env.DINODIA_HEALTHCHECK_REQUIRE_GOOGLE_NEST === "true" && health?.integrations?.googleNest?.configured && health.integrations.googleNest.status !== "connected") throw new Error("Google Nest is required but not connected");
    console.log(JSON.stringify(bodies));
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
