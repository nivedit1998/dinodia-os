const test = require("node:test");
const assert = require("node:assert/strict");
const { assertNoDockerNetworkOverlap, collectHostNetworks, conflictRows, parseIPv4Cidr } = require("../src/dockerNetworkGuard");

const hostAddresses = (ip, prefix = 24) => [{
  ifname: "eth0",
  addr_info: [{ family: "inet", local: ip, prefixlen: prefix }],
}];
const dockerNetwork = (subnet, gateway, id = "deadbeef") => ({
  Id: id,
  Name: `network-${id}`,
  Driver: "bridge",
  IPAM: { Config: [{ Subnet: subnet, Gateway: gateway }] },
  Containers: {},
});

test("IPv4 CIDR parsing handles host routes and rejects malformed addresses", () => {
  assert.equal(parseIPv4Cidr("192.168.0.0/20").prefix, 20);
  assert.equal(parseIPv4Cidr("192.168.0.1/33"), null);
  assert.equal(parseIPv4Cidr("999.0.0.1/24"), null);
  assert.equal(parseIPv4Cidr("192.168.1.0/24").first, parseIPv4Cidr("192.168.1.20/24").first);
});

test("an overlapping Docker bridge is detected against the routed LAN when its bridge interface is link-down", () => {
  const docker = dockerNetwork("192.0.2.0/24", "192.0.2.1", "deadbeef");
  const addresses = hostAddresses("192.0.2.110");
  addresses.push({ ifname: "br-deadbeef", operstate: "DOWN", addr_info: [{ family: "inet", local: "192.0.2.1", prefixlen: 24 }] });
  const hosts = collectHostNetworks(addresses, [{ dst: "192.0.2.0/24", dev: "eth0" }]);
  const conflicts = conflictRows([docker], hosts);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].interface, "eth0");
});

test("overlap guard allows a non-overlapping current LAN and an unrelated VPN route", async () => {
  const rows = new Map([
    ["ip -j -4 address show", JSON.stringify(hostAddresses("10.12.0.22"))],
    ["ip -j -4 route show table all", JSON.stringify([{ dst: "10.12.0.0/24", dev: "eth0" }, { dst: "172.30.0.0/16", dev: "tun0" }])],
    ["network ls --no-trunc --format {{.ID}}", "deadbeef"],
    ["network inspect deadbeef", JSON.stringify([dockerNetwork("192.168.0.0/20", "192.168.0.1")])],
  ]);
  const result = await assertNoDockerNetworkOverlap({ runCommand: async (_command, args) => ({ stdout: rows.get(args.join(" ")) || "" }) });
  assert.deepEqual(result, { safe: true, networksChecked: 1 });
});

test("overlap guard rejects conflicts with routed VPN ranges and other Docker IPAM pools", async () => {
  const networks = [dockerNetwork("10.30.0.0/16", "10.30.0.1", "a"), dockerNetwork("10.30.1.0/24", "10.30.1.1", "b")];
  const runCommand = async (_command, args) => {
    const key = args.join(" ");
    if (key === "-j -4 address show") return { stdout: JSON.stringify(hostAddresses("192.168.10.2")) };
    if (key === "-j -4 route show table all") return { stdout: JSON.stringify([{ dst: "10.30.0.0/16", dev: "tun0" }]) };
    if (key === "network ls --no-trunc --format {{.ID}}") return { stdout: "a\nb" };
    if (key === "network inspect a") return { stdout: JSON.stringify([networks[0]]) };
    if (key === "network inspect b") return { stdout: JSON.stringify([networks[1]]) };
    throw new Error(`unexpected command ${key}`);
  };
  await assert.rejects(assertNoDockerNetworkOverlap({ runCommand }), (error) => error.code === "docker_network_lan_overlap");
});
