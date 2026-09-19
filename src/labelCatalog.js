const FIXED_LABELS = Object.freeze([
  Object.freeze({ id: "light", name: "Light" }),
  Object.freeze({ id: "boiler", name: "Boiler" }),
  Object.freeze({ id: "radiator", name: "Radiator" }),
  Object.freeze({ id: "tenant_device", name: "Tenant Device" }),
]);

function fixedLabelState() {
  return Object.fromEntries(FIXED_LABELS.map((label) => [label.id, {
    id: label.id,
    name: label.name,
    color: "teal",
    updatedAt: null,
  }]));
}

module.exports = { FIXED_LABELS, fixedLabelState };
