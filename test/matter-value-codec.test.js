const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeMatterValue, endpointInventory } = require('../src/integrations/matter/valueCodec');
const { normalizeMatterNode } = require('../src/integrations/matter/nodeNormalizer');
const { commandForBinding } = require('../src/integrations/matter/commandAdapter');
test('Matter scalar conversion preserves unknown values and canonical opening direction', () => {
  assert.equal(decodeMatterValue(513, 0, 2150), 21.5);
  assert.equal(decodeMatterValue(513, 18, 1950), 19.5);
  for (const v of [null, -32768, '2150', NaN]) assert.equal(decodeMatterValue(513, 0, v), null);
  assert.equal(decodeMatterValue(258, 8, 0), 100);
  assert.equal(decodeMatterValue(258, 8, 100), 0);
  assert.equal(decodeMatterValue(258, 14, 3500), 65);
  assert.equal(decodeMatterValue(258, 8, 255), null);
});
test('Matter thermostat controls use Celsius with exact validated attribute-write encoding', () => {
  const device = normalizeMatterNode({node_id:55, attributes:{'1/513/0':2150,'1/513/18':1950,'1/513/21':700,'1/513/22':3500}});
  const target = Object.values(device.entities).find(e=>e.binding.attributeId==='18');
  assert.equal(target.state,19.5);
  assert.equal(target.capability.writable,true);
  assert.equal(target.capability.constraints.min,7);
  assert.deepEqual(commandForBinding(target,'climate.set_temperature',{temperature:22.5},device),
    {endpoint_id:1,cluster_id:513,attribute_id:18,operation:'set_temperature',attribute_value:2250});
  for(const temperature of [null,'22.5',6,36,NaN,22.555]) assert.throws(()=>commandForBinding(target,'climate.set_temperature',{temperature},device));
});
test('flat inventory is authoritative and overflow cannot create writable fallback controls', () => {
  const n = { attributes: {'1/258/8': 30}, endpoints: {2: {clusters: {6: {attributes: {0: true}}}}} };
  assert.deepEqual(Object.keys(endpointInventory(n).endpoints), ['1']);
  assert.equal(endpointInventory({attributes: Object.fromEntries(Array.from({length:8193}, (_,i)=>[`1/1/${i}`,0]))}).incomplete,true);
});
