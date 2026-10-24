const { withEntitlementsPlist } = require("expo/config-plugins");

/**
 * Drops the APNs entitlement expo-notifications adds, so the iOS app signs with a provisioning
 * profile that has no Push Notifications capability. List it before expo-notifications: mods run
 * in reverse order, so this one sees the entitlement after expo-notifications has written it.
 */
function removeIosPushEntitlement(config) {
  return withEntitlementsPlist(config, (modConfig) => {
    delete modConfig.modResults["aps-environment"];
    return modConfig;
  });
}

module.exports = removeIosPushEntitlement;
