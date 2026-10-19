"use strict";

const DOCKER_INTERFACE = /^(?:docker\d*|br-[a-f0-9]+|veth[a-f0-9]+|virbr\d*|cni\d*|flannel\d*|podman\d*)$/i;

function ipv4Number(address) {
  const parts = String(address || "").split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);
}

function parseIPv4Cidr(value) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(String(value || ""));
  if (!match) return null;
  const address = ipv4Number(match[1]);
  const prefix = match[2] === undefined ? 32 : Number(match[2]);
  if (address === null || prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const first = (address & mask) >>> 0;
  const last = (first | (~mask >>> 0)) >>> 0;
  return { cidr: `${match[1]}/${prefix}`, first, last, prefix };
}

function cidrsOverlap(leftValue, rightValue) {
  const left = typeof leftValue === "string" ? parseIPv4Cidr(leftValue) : leftValue;
  const right = typeof rightValue === "string" ? parseIPv4Cidr(rightValue) : rightValue;
  return Boolean(left && right && left.first <= right.last && right.first <= left.last);
}

function collectHostNetworks(addresses, routes) {
  const networks = [];
  for (const iface of Array.isArray(addresses) ? addresses : []) {
    const name = String(iface.ifname || "");
    if (!name || name === "lo" || DOCKER_INTERFACE.test(name)) continue;
    for (const info of iface.addr_info || []) {
      if (info.family !== "inet" || !info.local || !Number.isInteger(Number(info.prefixlen))) continue;
      const cidr = parseIPv4Cidr(`${info.local}/${Number(info.prefixlen)}`);
      if (cidr) networks.push({ interface: name, source: "address", ...cidr });
    }
  }
  for (const route of Array.isArray(routes) ? routes : []) {
    const name = String(route.dev || "");
    const destination = String(route.dst || "");
    if (!name || name === "lo" || DOCKER_INTERFACE.test(name) || !destination || destination === "default" || route.type === "local") continue;
    const cidr = parseIPv4Cidr(destination);
    if (cidr) networks.push({ interface: name, source: "route", ...cidr });
  }
  const unique = new Map();
  for (const network of networks) {
    const key = `${network.interface}|${network.first}|${network.last}`;
    if (!unique.has(key) || network.source === "address") unique.set(key, network);
  }
  return [...unique.values()];
}

function conflictRows(dockerNetworks, hostNetworks) {
  const conflicts = [];
  for (const network of dockerNetworks) {
    const id = String(network?.Id || network?.ID || "");
    const name = String(network?.Name || "unknown");
    for (const config of network?.IPAM?.Config || []) {
      const subnet = parseIPv4Cidr(config?.Subnet);
      if (!subnet) continue;
      for (const host of hostNetworks) {
        if (cidrsOverlap(subnet, host)) conflicts.push({ id, name, subnet: config.Subnet, interface: host.interface, hostCidr: host.cidr, hostSource: host.source });
      }
    }
  }
  for (let leftIndex = 0; leftIndex < dockerNetworks.length; leftIndex += 1) {
    const left = dockerNetworks[leftIndex];
    const leftId = String(left?.Id || left?.ID || "");
    for (let rightIndex = leftIndex + 1; rightIndex < dockerNetworks.length; rightIndex += 1) {
      const right = dockerNetworks[rightIndex];
      const rightId = String(right?.Id || right?.ID || "");
      for (const leftConfig of left?.IPAM?.Config || []) {
        const leftSubnet = parseIPv4Cidr(leftConfig?.Subnet);
        if (!leftSubnet) continue;
        for (const rightConfig of right?.IPAM?.Config || []) {
          const rightSubnet = parseIPv4Cidr(rightConfig?.Subnet);
          if (rightSubnet && cidrsOverlap(leftSubnet, rightSubnet)) {
            conflicts.push({
              id: leftId,
              name: String(left?.Name || "unknown"),
              subnet: leftConfig.Subnet,
              overlapsDockerNetworkId: rightId,
              overlapsDockerNetwork: String(right?.Name || "unknown"),
              hostSource: "docker-ipam",
              hostCidr: rightConfig.Subnet,
            });
          }
        }
      }
    }
  }
  return conflicts;
}

async function assertNoDockerNetworkOverlap({ dockerBinary = "docker", runCommand } = {}) {
  if (typeof runCommand !== "function") throw new TypeError("A bounded command runner is required for the Docker LAN safety check");
  let addresses;
  let routes;
  let ids;
  try {
    addresses = JSON.parse((await runCommand("ip", ["-j", "-4", "address", "show"], { timeoutMs: 5000 })).stdout || "[]");
    routes = JSON.parse((await runCommand("ip", ["-j", "-4", "route", "show", "table", "all"], { timeoutMs: 5000 })).stdout || "[]");
    const listed = (await runCommand(dockerBinary, ["network", "ls", "--no-trunc", "--format", "{{.ID}}"], { timeoutMs: 10000 })).stdout || "";
    ids = listed.split(/\s+/).map((value) => value.trim()).filter(Boolean);
    if (!Array.isArray(addresses) || !Array.isArray(routes)) throw new Error("host_network_json_invalid");
  } catch (error) {
    throw Object.assign(new Error("Host routes or Docker network inventory could not be checked safely"), { code: "docker_network_guard_unavailable", cause: error });
  }
  const dockerNetworks = [];
  try {
    for (const id of ids) {
      const value = JSON.parse((await runCommand(dockerBinary, ["network", "inspect", id], { timeoutMs: 10000 })).stdout || "[]");
      if (!Array.isArray(value) || value.length !== 1) throw new Error("docker_network_inspect_invalid");
      dockerNetworks.push(value[0]);
    }
  } catch (error) {
    throw Object.assign(new Error("A Docker network definition could not be inspected safely"), { code: "docker_network_guard_unavailable", cause: error });
  }
  const conflicts = conflictRows(dockerNetworks, collectHostNetworks(addresses, routes));
  if (conflicts.length) {
    const first = conflicts[0];
    const overlap = first.hostSource === "docker-ipam"
      ? `Docker network ${first.overlapsDockerNetwork} (${first.hostCidr})`
      : `host network on ${first.interface} (${first.hostCidr})`;
    throw Object.assign(new Error(`Docker network ${first.name} (${first.subnet}) overlaps ${overlap}; refusing to start or recreate an integration bridge`), {
      code: "docker_network_lan_overlap", conflicts,
    });
  }
  for (const network of dockerNetworks) {
    const configs = network?.IPAM?.Config || [];
    if (String(network?.Driver || "") === "bridge" && configs.length === 0) {
      throw Object.assign(new Error(`Docker bridge ${String(network?.Name || "unknown")} has no inspectable IPAM configuration; refusing integration startup`), {
        code: "docker_network_guard_unavailable",
      });
    }
    if (String(network?.Driver || "") === "bridge" && configs.some((config) => String(config?.Subnet || "").includes(".") && !parseIPv4Cidr(config.Subnet))) {
      throw Object.assign(new Error(`Docker bridge ${String(network?.Name || "unknown")} has malformed IPv4 IPAM; refusing integration startup`), {
        code: "docker_network_guard_unavailable",
      });
    }
  }
  return { safe: true, networksChecked: dockerNetworks.length };
}

module.exports = { assertNoDockerNetworkOverlap, cidrsOverlap, collectHostNetworks, conflictRows, parseIPv4Cidr };
