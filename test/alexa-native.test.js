const test = require("node:test");
const assert = require("node:assert/strict");

const { nativeAlexaEndpointId, isNativeAlexaEndpointId } = require("../src/integrations/alexa/endpointId");
const { mapSurface, publicEndpointParts } = require("../src/integrations/alexa/capabilityMapper");
const { executeDirective } = require("../src/integrations/alexa/directiveService");

test("native Alexa endpoint IDs are stable, opaque, and scoped to one hub instance", () => {
  const first = nativeAlexaEndpointId({ hubInstanceId: "hub/home/001", deviceId: "zigbee:0x001", channelId: "light-main" });
  const second = nativeAlexaEndpointId({ hubInstanceId: "hub/home/001", deviceId: "zigbee:0x001", channelId: "light-main" });
  const otherHub = nativeAlexaEndpointId({ hubInstanceId: "hub/home/002", deviceId: "zigbee:0x001", channelId: "light-main" });
  assert.equal(first, second);
  assert.notEqual(first, otherHub);
  assert.match(first, /^dos_[A-Za-z0-9_-]{16,80}$/);
  assert.equal(isNativeAlexaEndpointId(first), true);
  assert.equal(isNativeAlexaEndpointId("ha_switch.fake"), false);
});

test("capability mapping exposes only safe Alexa interfaces and typed bindings", () => {
  const mapped = mapSurface({
    id: "light.main",
    domain: "light",
    available: true,
    state: "on",
    attributes: { brightness: 42 },
    serviceRoutes: {
      "light.turn_on": { entityId: "light.main", parameters: { brightness: { type: "number" } } },
      "light.turn_off": { entityId: "light.main" },
    },
  });
  const publicParts = publicEndpointParts(mapped);
  assert.deepEqual(publicParts.capabilities.map((item) => item.interface), ["Alexa", "Alexa.EndpointHealth", "Alexa.PowerController", "Alexa.BrightnessController"]);
  assert.equal(publicParts.controls.some((item) => Object.hasOwn(item, "serviceId")), false);
  assert.equal(publicParts._bindings[0].serviceId, "light.turn_on");
  assert.equal(publicParts.state.find((item) => item.namespace === "Alexa.PowerController").value, "ON");
});

test("native directives resolve internal bindings without exposing execution routes", async () => {
  const endpointId = nativeAlexaEndpointId({ hubInstanceId: "hub-001", deviceId: "device-001", channelId: "light.main" });
  const calls = [];
  const catalogue = {
    endpoints: [{ endpointId, available: true, deviceId: "device-001", channelId: "light.main", controls: [] }],
    _internalEndpoints: [{
      endpointId,
      available: true,
      deviceId: "device-001",
      channelId: "light.main",
      _bindings: [{ directiveKey: "Alexa.PowerController/TurnOn", namespace: "Alexa.PowerController", name: "TurnOn", serviceId: "light.turn_on" }],
    }],
  };
  const result = await executeDirective({
    catalogue,
    directive: { endpoint: { endpointId }, header: { namespace: "Alexa.PowerController", name: "TurnOn", messageId: "message-1" }, payload: {} },
    executeControl: async (call) => calls.push(call),
  });
  assert.equal(result.endpointId, endpointId);
  assert.deepEqual(calls, [{ deviceId: "device-001", surfaceId: "light.main", serviceId: "light.turn_on", data: {}, messageId: "message-1" }]);
});
