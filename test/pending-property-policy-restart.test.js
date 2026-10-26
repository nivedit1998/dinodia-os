'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {Store}=require('../src/store');
const policy=()=>({managementClass:'PROPERTY_DEVICE',ownerMembershipId:null,lifecycle:'INSTALLED',
  platformDeviceId:crypto.randomUUID(),installationRequestId:crypto.randomUUID(),canonicalAreaIds:[crypto.randomUUID()],
  catalogueStatus:'ready',usefulReadings:true,descriptorRevision:6,descriptorDigest:'a'.repeat(64),overrideName:'Installed device'});
for(const category of ['NONE','LIGHT','RADIATOR','BOILER'])test(`pending ${category} canonical category and inventory survive a real Store restart`,async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dinodia-pending-policy-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'store.json'),store=new Store(file),p={...policy(),analyticsCategory:category,inventoryRevision:7,customerLabel:'My label'};
  await store.savePlatform({pendingPropertyDevicePolicies:{'zigbee:test':p}});
  const rebooted=new Store(file),restored=rebooted.getPlatform().devicePolicies['zigbee:test'];
  assert.equal(restored.analyticsCategory,category);assert.equal(restored.inventoryRevision,7);assert.equal(restored.customerLabel,'My label');
  assert.equal(restored.platformDeviceId,p.platformDeviceId);assert.equal(restored.ownerMembershipId,null);
});
test('legacy pending policies are not upgraded into analytics and malformed new fields fail closed',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'dinodia-pending-policy-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'store.json'),store=new Store(file);
  await store.savePlatform({pendingPropertyDevicePolicies:{'zigbee:legacy':policy(),
    'zigbee:badcategory':{...policy(),analyticsCategory:'GAS'},'zigbee:badrevision':{...policy(),analyticsCategory:'LIGHT',inventoryRevision:-1}}});
  const policies=new Store(file).getPlatform().devicePolicies;
  assert.equal(policies['zigbee:legacy'].analyticsCategory,'NONE');
  assert.equal(policies['zigbee:badcategory'],undefined);assert.equal(policies['zigbee:badrevision'],undefined);
});
