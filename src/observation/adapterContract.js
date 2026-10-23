'use strict';
function validateReadObservation(target, request, response, now) {
  const observed = Date.parse(String(response?.observedAt || ''));
  const allowed = new Set([...Object.keys(request), 'value', 'rawValue', 'observedAt', 'provenance', 'networkRead']);
  if (!response || Object.keys(response).some(key => !allowed.has(key)) || response.networkRead !== true || response.provenance !== 'device_read' || response.requestId !== request.requestId
    || response.deviceId !== target.deviceId || response.controlId !== target.controlId || response.endpointId !== target.endpointId
    || !Number.isFinite(observed) || observed > now || observed < request.sentAt || now - observed > 30000
    || typeof response.value !== 'boolean' && (typeof response.value !== 'number' || !Number.isFinite(response.value))) return null;
  return { ...response, observedAt: new Date(observed).toISOString(), validUntil: new Date(observed + 360000).toISOString() };
}
module.exports = { validateReadObservation };
