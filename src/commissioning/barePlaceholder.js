'use strict';

// A record named only by its radio address: never interviewed, no model, no room, no platform policy. It is a leftover of an
// earlier join or removal, not a device the hub knows. Discovery messages can give it controls, so controls do not count.
function isBarePlaceholder(device, platform = null) {
  return String(device?.protocol || '').toLowerCase() === 'zigbee' && device.interviewStatus !== 'successful'
    && !device.metadata?.model && !device.metadata?.model_id && !device.areaId && device.setup?.status === 'needs_setup'
    && !platform?.devicePolicies?.[String(device.id)];
}

module.exports = { isBarePlaceholder };
