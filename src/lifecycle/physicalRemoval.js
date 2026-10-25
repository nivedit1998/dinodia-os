'use strict';

/** Called only by an already-confirmed durable deletion, never by discovery. */
async function removePhysical({ device, mqtt, matter, matterPairing, hive, googleNest }) {
  if (device.protocol === 'zigbee') {
    const inventory = mqtt.deviceInventorySnapshot?.();
    const ieee = String(device.protocolIdentity?.ieeeAddress || device.metadata?.ieee_address || '');
    const absent = inventory?.complete === true && inventory.current === true
      && Array.isArray(inventory.devices) && !inventory.devices.some(row =>
        row.id === device.id || ieee && String(row.protocolIdentity?.ieeeAddress || row.metadata?.ieee_address || '') === ieee);
    if (!absent) await mqtt.remove(device.id, false, { block: true });
    mqtt.forgetDevice?.(device.id);
    return { acknowledged: true, kind: absent ? 'coordinator_absence_confirmed' : 'coordinator_removal' };
  }
  if (device.protocol === 'matter') {
    if (!matter.connected) throw new Error('Matter controller is not connected');
    // This is the controller's existing inventory/subscription API, not a
    // guessed provider method or a device state poll.
    const result = await matter.request('start_listening', {});
    const nodes = Array.isArray(result) ? result : Array.isArray(result?.nodes) ? result.nodes : null;
    if (!nodes) throw new Error('Matter controller did not return a complete inventory');
    const nodeId = String(device.protocolIdentity?.nodeId || '');
    if (!nodeId) throw new Error('Matter physical identity is unavailable');
    const present = nodes.some(node => String(node.node_id ?? node.id ?? '') === nodeId);
    if (present) await matter.remove(device.id);
    matter.forgetDevice?.(device.id); matterPairing?.forgetDevice?.(device.id);
    return { acknowledged: true, kind: present ? 'controller_fabric_removal' : 'controller_absence_confirmed' };
  }
  if (device.protocol === 'hive' || device.protocol === 'google_nest') {
    await (device.protocol === 'hive' ? hive : googleNest).ignoreDevice(device);
    return { acknowledged: true, kind: 'local_provider_detachment' };
  }
  throw Object.assign(new Error('This integration has no verified removal operation'), {
    code: 'area_delete_removal_unsupported', statusCode: 409 });
}
module.exports = { removePhysical };
