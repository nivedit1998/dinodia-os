import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Matter } from "@matter/model";
import { getClusterNameById } from "@matter/types";

const require = createRequire(import.meta.url);
const packageVersion = JSON.parse(await fs.readFile(path.join(path.dirname(require.resolve("@matter/model")), "..", "..", "package.json"), "utf8")).version;
const typesPackageVersion = JSON.parse(await fs.readFile(path.join(path.dirname(require.resolve("@matter/types")), "..", "..", "package.json"), "utf8")).version;
const output = process.env.MATTER_CATALOG_OUTPUT || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "generated", "matterCatalog.json");

function primitive(value) {
  if (value === undefined || value === null) return undefined;
  if (["string", "number", "boolean"].includes(typeof value)) return value;
  if (typeof value?.value === "number" || typeof value?.value === "string") return value.value;
  return undefined;
}

function constraints(attribute) {
  const constraint = attribute?.constraint;
  if (!constraint || constraint.isEmpty) return {};
  const result = {};
  const min = primitive(constraint.min);
  const max = primitive(constraint.max);
  if (min !== undefined) result.min = min;
  if (max !== undefined) result.max = max;
  return result;
}

function serializeAttribute(attribute) {
  const result = {
    name: attribute.name,
    type: String(attribute.type || "unknown"),
    writable: String(attribute.access?.rw || "").includes("W"),
    ...(String(attribute.quality?.definition || "").includes("V") ? { nullable: true } : {}),
    ...constraints(attribute),
  };
  return result;
}

const clusters = {};
for (const model of Matter.clusters) {
  if (!Number.isInteger(model.id)) continue;
  const attributes = {};
  for (const attribute of model.attributes || []) {
    if (Number.isInteger(attribute.id)) attributes[String(attribute.id)] = serializeAttribute(attribute);
  }
  const commands = (model.commands || []).filter((command) => Number.isInteger(command.id)).map((command) => ({ id: String(command.id), name: command.name }));
  const events = (model.events || []).filter((event) => Number.isInteger(event.id)).map((event) => ({ id: String(event.id), name: event.name }));
  clusters[String(model.id)] = {
    name: model.name || getClusterNameById(model.id) || `Cluster ${model.id}`,
    revision: primitive(model.revision),
    attributes,
    commands,
    events,
  };
}

const deviceTypes = {};
for (const model of Matter.deviceTypes) {
  if (Number.isInteger(model.id)) deviceTypes[String(model.id)] = model.name;
}

const data = {
  schemaVersion: 1,
  source: "@matter/model + @matter/types",
  sourceVersions: { model: packageVersion, types: typesPackageVersion },
  clusters,
  deviceTypes,
};

await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
console.log(`Generated ${Object.keys(clusters).length} Matter clusters and ${Object.keys(deviceTypes).length} device types at ${output}`);
