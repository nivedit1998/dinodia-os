'use strict';

// What a newly found device most likely is, from what its radio says about itself. A plain on/off device (a plug, relay or wall switch)
// cannot say what it switches, so it gets no suggestion; only an unambiguous signal does. Never guessed from a brand or model.
function roleSet(device) {
  const roles = new Set();
  const domains = new Set();
  for (const entity of Object.values(device?.entities || {})) {
    if (!entity || typeof entity !== 'object') continue;
    const category = String(entity.category || entity.capability?.category || '').toLowerCase();
    if (category === 'diagnostic' || category === 'config') continue;
    if (entity.capability?.semanticRole) roles.add(String(entity.capability.semanticRole));
    if (entity.domain) domains.add(String(entity.domain).toLowerCase());
  }
  return { roles, domains };
}

function describeKind(device) {
  const { roles, domains } = roleSet(device);
  const onOff = roles.has('power');
  let suggestedKind = null;
  if (roles.has('active_heat_production')) suggestedKind = 'Boiler';
  else if (roles.has('target_temperature') || roles.has('active_heat_demand') || domains.has('climate')) suggestedKind = 'Radiator';
  else if (roles.has('brightness') || roles.has('color') || domains.has('light')) suggestedKind = 'Light';
  return { suggestedKind, onOff };
}

module.exports = { describeKind };
