const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Store } = require("../src/store");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dinodia-request-loss-"));
  t.after(() => fs.rm(directory, {recursive:true, force:true}));
  const file = path.join(directory, "dinodia.json");
  const store = new Store(file);
  await store.saveArea({name:"Room 1"}, "room-one");
  await store.savePlatform({paired:true, homeId:"test-home", hubInstallId:"test-hub", cloudRevision:17});
  await store.commit(state => {
    Object.assign(state.syncOutbox, {acknowledgedSequence:10, nextSequence:14, cloudRevision:17,
      configurationAppliedRevision:17, lastErrorCode:"hub_sync_stream_reconciliation_required", inFlight:null,
      events:[
        {id:crypto.randomUUID(), sequence:11, type:"sync.compacted", aggregateId:"", payload:{supersededBy:12}, critical:false, occurredAt:"2026-10-18T10:00:00.000Z"},
        {id:crypto.randomUUID(), sequence:12, type:"temperature.sample", aggregateId:"temperature", payload:{observedAt:"2026-10-18T10:00:01.000Z", value:20}, critical:false, occurredAt:"2026-10-18T10:00:01.000Z"},
        {id:crypto.randomUUID(), sequence:13, type:"incident.transition", aggregateId:"incident", payload:{revision:2}, critical:true, occurredAt:"2026-10-18T10:00:02.000Z"},
      ]});
  });
  const original = store.getSyncOutbox();
  const input = {previousStreamId:original.streamId, previousAcknowledgedSequence:10, previousNextSequence:14,
    serverAcceptedSequence:11, acceptedRequestBodyHash:"a".repeat(64), now:Date.parse("2026-10-19T08:00:00Z")};
  return {store,file,original,input};
}

test("request-loss recovery preserves every pending event and archives the original cursor instead of fast-forwarding it", async t => {
  const {store,file,original,input} = await fixture(t);
  const result = await store.prepareSyncRequestLossRecovery(input);
  const current=store.getSyncOutbox();
  assert.notEqual(current.streamId, original.streamId);
  assert.equal(current.acknowledgedSequence,0);
  assert.equal(current.events[0].type,"area.upsert");
  const retained=current.events.slice(-original.events.length);
  assert.deepEqual(retained.filter(e=>e.type!=="sync.compacted").map(({sequence,...e})=>e),original.events.filter(e=>e.type!=="sync.compacted").map(({sequence,...e})=>e));
  assert.equal(retained[0].id,original.events[0].id);
  assert.equal(retained[0].payload.supersededBy,retained[1].sequence);
  assert.deepEqual(current.events.map(e=>e.sequence),current.events.map((_,i)=>i+1));
  assert.equal(current.requestLossRecovery.retainedEventCount,3);
  const archive=JSON.parse(await fs.readFile(result.archivedOutboxPath,"utf8"));
  assert.deepEqual(archive.outbox,original);
  assert.equal((await fs.stat(result.archivedOutboxPath)).mode&0o777,0o600);
  const restart=new Store(file);
  assert.deepEqual(restart.getSyncOutbox(),current);
  assert.equal(restart.listAreas()[0].name,"Room 1");
  await assert.rejects(restart.prepareSyncRequestLossRecovery(input),{code:"hub_sync_request_loss_recovery_not_eligible"});
});

test("request-loss recovery refuses unknown outcomes, gaps, changed cursors and non-marker heads without changing the outbox", async t => {
  const changes=[
    o=>{o.inFlight={fromSequence:11,toSequence:11};},
    o=>{o.gapDetected=true;}, o=>{o.criticalBacklog=true;}, o=>{o.telemetryPaused=true;},
    o=>{o.droppedTelemetryCount=1;}, o=>{o.events[0].type="area.tombstone";o.events[0].critical=true;},
    o=>{o.events[0].critical=true;}, o=>{o.events.splice(1,1);},
  ];
  for(const change of changes){
    const {store,input}=await fixture(t);await store.commit(s=>change(s.syncOutbox));const before=store.getSyncOutbox();
    await assert.rejects(store.prepareSyncRequestLossRecovery(input),{code:"hub_sync_request_loss_recovery_not_eligible"});
    assert.deepEqual(store.getSyncOutbox(),before);
  }
  for(const patch of [{serverAcceptedSequence:12},{previousAcknowledgedSequence:9},{previousNextSequence:15},{acceptedRequestBodyHash:"invalid"}]){
    const {store,input}=await fixture(t);const before=store.getSyncOutbox();
    await assert.rejects(store.prepareSyncRequestLossRecovery({...input,...patch}),{code:"hub_sync_request_loss_recovery_not_eligible"});
    assert.deepEqual(store.getSyncOutbox(),before);
  }
});

test("replacement stream uses ordinary exact reconciliation and marks recovery complete only after real receipts cover retained events", async t => {
  const {store,input}=await fixture(t);
  await store.prepareSyncRequestLossRecovery(input);
  const batch=await store.prepareSyncBatch("test-hub",{kind:"dinodia_os",version:"2.0.0",capabilities:{}},input.now);
  const marked=await store.prepareSyncStreamReconciliation({previousStreamId:input.previousStreamId,previousAcceptedSequence:11});
  assert.equal(marked.streamId,batch.streamId);
  assert.equal(marked.streamReconciliation.previousAcceptedSequence,11);
  assert.equal(store.getSyncOutbox().requestLossRecovery.completedAt,null);
  await store.acknowledgeSyncBatch({streamId:batch.streamId,acceptedThroughSequence:batch.toSequence},input.now+1000);
  assert.equal(store.getSyncOutbox().requestLossRecovery.completedAt,new Date(input.now+1000).toISOString());
});

test("a failed recovery commit retains the original cursor and queue and allows reuse of its identical private archive", async t => {
  const {store,original,input}=await fixture(t);
  const persist=store.persist;
  store.persist=async()=>{throw Error("injected pre-commit failure");};
  await assert.rejects(store.prepareSyncRequestLossRecovery(input),/injected pre-commit failure/);
  assert.deepEqual(store.getSyncOutbox(),original);
  store.persist=persist;
  const result=await store.prepareSyncRequestLossRecovery(input);
  assert.deepEqual(JSON.parse(await fs.readFile(result.archivedOutboxPath,"utf8")).outbox,original);
});

test("retained telemetry survives multi-batch restart and recovery stays pending until the last retained receipt", async t => {
  const {store,file,input}=await fixture(t);
  await store.commit(state=>{
    for(let i=14;i<=110;i++)state.syncOutbox.events.push({id:crypto.randomUUID(),sequence:i,type:"temperature.sample",
      aggregateId:`sample-${i}`,occurredAt:"2026-10-18T10:00:03.000Z",critical:false,
      payload:{observedAt:"2026-10-18T10:00:03.000Z",value:19.5}});
    state.syncOutbox.nextSequence=111;
  });
  await store.prepareSyncRequestLossRecovery({...input,previousNextSequence:111});
  const prepared=store.getSyncOutbox(),originalIds=prepared.events.map(e=>e.id);
  let current=store,receipts=0;
  while(current.getSyncOutbox().events.length){
    const batch=await current.prepareSyncBatch("test-hub",{kind:"dinodia_os",version:"2.0.0",capabilities:{}},input.now);
    const restarted=new Store(file);
    assert.deepEqual(await restarted.prepareSyncBatch("test-hub",{},input.now+5000),batch,"restart retries the exact prepared bytes");
    await restarted.acknowledgeSyncBatch({streamId:batch.streamId,acceptedThroughSequence:batch.toSequence},input.now+1000);
    current=restarted;receipts++;
    if(current.getSyncOutbox().events.length)assert.equal(current.getSyncOutbox().requestLossRecovery.completedAt,null);
  }
  assert.ok(receipts>=3);
  assert.equal(new Set(originalIds).size,originalIds.length);
  assert.ok(current.getSyncOutbox().requestLossRecovery.completedAt);
});
