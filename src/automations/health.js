const { clone } = require("./domain");
const { healthFromIssues, validateAgainstCatalogue } = require("./validator");

function projectAutomationHealth({ automation, actions = [], catalogue = [], authorizedDeviceIds = null, nextRunAt = null } = {}) {
  const issues = validateAgainstCatalogue({ ...automation, actions }, catalogue, { authorizedDeviceIds });
  return healthFromIssues(issues, nextRunAt);
}

function projectAutomation({ automation, trigger, actions, catalogue = [], authorizedDeviceIds = null, nextRunAt = null } = {}) {
  const result = {
    ...clone(automation),
    trigger: clone(trigger),
    actions: clone(actions || []),
    health: projectAutomationHealth({ automation, actions, catalogue, authorizedDeviceIds, nextRunAt }),
  };
  return result;
}

module.exports = { projectAutomation, projectAutomationHealth };
