// Unit fixtures which start AFTER the bridge handshake/cache flush explicitly
// model those prerequisites. The full inventory/options/flush flow is covered
// separately by observation-publisher-runtime.test.js.
const fs=require('node:fs');
const {parseYamlSections}=require('../../src/integrations/zigbee/observationContract');
async function readyPublisher(bridge) {
  const config=parseYamlSections(fs.readFileSync(bridge.observationConfigPath,'utf8'));
  bridge.connected=true;
  bridge.deviceInventory={complete:true,connectionGeneration:bridge.connectionGeneration,devices:bridge.store.listDevices()};
  const clock=bridge.publisherObservation.clock;
  bridge.publisherObservation.clock=()=>0;
  try {
    await bridge.handleMessage('zigbee2mqtt/bridge/info',Buffer.from(JSON.stringify({restart_required:false,config:{
      advanced:config.advanced,devices:Object.fromEntries(config.devices.map(d=>[d.key,{...d.values,filtered_cache:d.filteredCache}]))}})),{retain:true});
    for(const device of bridge.store.listDevices())bridge.publisherObservation.admit(device.id,new Date(0).toISOString());
  }finally{bridge.publisherObservation.clock=clock;}
}
module.exports={readyPublisher};
