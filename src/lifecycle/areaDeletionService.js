'use strict';
const crypto = require('node:crypto');
const endpoint = '/api/hub-agent/v2/area-deletion';
const fail = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };
const same = (left, right) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

/** Only the selected, currently revalidated full-Home operator may call this coordinator. */
class AreaDeletionService {
  constructor({ store, platform, removePhysical }) {
    this.store = store; this.platform = platform; this.removePhysical = removePhysical;
    this.previews = new Map(); this.queue = Promise.resolve();
  }
  proof(principal) {
    if (principal?.scope?.length !== 1 || principal.scope[0] !== 'os:admin' || !principal.handoffId || !principal.jti)
      fail('area_delete_scope_denied', 'A current full Home operator is required');
    return { handoffId: principal.handoffId, jti: principal.jti, credentialVersion: Number(principal.credentialVersion || 0) };
  }
  async preview(principal, areaId) {
    const proof = this.proof(principal);
    const local = this.store.areaDeletionPlan(areaId);
    const binding = this.store.getPlatform().areaBindings?.find(row => row.hubAreaId === areaId);
    if (!binding) fail('area_delete_area_not_synchronised', 'Wait for this Area to synchronise');
    const operationId = crypto.randomUUID();
    const cloud = await this.platform(endpoint, { action: 'preview', operationId, areaId: binding.areaId, ...proof });
    if (cloud.osAreaId !== areaId || !Array.isArray(cloud.osDeviceIds)
      || !same(local.targets.map(target => target.id), cloud.osDeviceIds))
      fail('area_delete_inventory_not_synchronised', 'Local and cloud device inventories differ; deletion was not started');
    this.previews.set(operationId, { areaId, local, cloudDigest: cloud.digest, actor: principal.jti, expiresAt: Date.now() + 10 * 60_000 });
    // Counts only: private identity/state is never returned in the operator impact summary.
    return { operationId, digest: local.digest, areaName: local.name, deviceCount: local.targets.length,
      sharedHardwarePreserved: local.parents.filter(parent => parent.preservedChildren.length).length,
      providerDetachments: local.parents.filter(parent => !parent.preservedChildren.length && ['hive', 'google_nest'].includes(parent.protocol)).length,
      warning: 'This permanently deletes this Area, its grants, QR codes, device controls and readings, including tenant-private devices. Shared hardware used in another Area remains paired.' };
  }
  serial(work) {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  confirm(principal, input) {
    return this.serial(async () => {
      this.proof(principal);
      let job = this.store.areaDeletionJob(input.operationId);
      if (!job) {
        const preview = this.store.snapshot().areaDeletionIntents?.[input.operationId] || this.previews.get(input.operationId);
        if (!preview || (!preview.confirmed && (preview.actor !== principal.jti || preview.expiresAt <= Date.now()))
          || preview.local.digest !== input.digest || input.confirmationName !== preview.local.name)
          fail('area_delete_preview_expired', 'Review a new deletion preview');
        if (input.areaId && input.areaId !== preview.areaId) fail('area_delete_operation_conflict', 'The selected Area changed');
        // Persist confirmed intent BEFORE the network reservation. A process
        // crash can then rediscover and resume the exact same operation.
        await this.store.commit(state => {
          state.areaDeletionIntents ||= {};
          state.areaDeletionIntents[input.operationId] = { ...preview, confirmed: true };
        });
        const reserved = await this.platform(endpoint, { action: 'reserve', operationId: input.operationId,
          ...this.proof(principal), digest: preview.cloudDigest, confirmationName: input.confirmationName });
        if (reserved.state !== 'RESERVED') fail('area_delete_cloud_reservation_missing', 'The cloud has not reserved this exact deletion intent');
        job = await this.store.fenceAreaDeletion(input.operationId, { areaId: preview.areaId,
          digest: input.digest, cloudDigest: preview.cloudDigest, confirmationName: input.confirmationName });
      }
      return this.resume(principal, job, input.confirmationName);
    });
  }
  async resume(principal, job, confirmationName) {
    const proof = this.proof(principal);
    if (job.state === 'COMPLETE') return { operationId: job.operationId, state: 'COMPLETE', providerDetachments: job.providerDetachments || 0 };
    if (job.state === 'FENCED') {
      const cloud = await this.platform(endpoint, { action: 'commit', operationId: job.operationId, ...proof,
        digest: job.cloudDigest, localFenceDigest: job.fenceDigest, confirmationName });
      if (!['WAITING_HUB', 'COMPLETE'].includes(cloud.state)) fail('area_delete_cloud_pending', 'Cloud revocation is not yet acknowledged');
      job = await this.store.progressAreaDeletion(job.operationId, { cloudCommitted: true });
    }
    if (job.state === 'CLOUD_COMMITTED') {
      for (const [physicalId, status] of Object.entries(job.physical)) {
        if (status !== 'REMOVAL_PENDING') continue;
        const parent = this.store.getDevice(physicalId);
        if (!parent) fail('area_delete_transport_evidence_missing', 'Physical removal needs supervised recovery');
        // Never force-remove or report timeout as successful unpairing. No call for shared parents.
        const acknowledgement = await this.removePhysical(parent);
        if (acknowledgement?.acknowledged !== true) fail('area_delete_physical_pending', 'The adapter has not acknowledged removal');
        job = await this.store.progressAreaDeletion(job.operationId, { physicalAcknowledged: physicalId, removalKind: acknowledgement.kind });
      }
      job = await this.store.progressAreaDeletion(job.operationId, { purge: true });
    }
    const result = await this.platform(endpoint, { action: 'finish', operationId: job.operationId, localFenceDigest: job.fenceDigest });
    if (result.state !== 'COMPLETE') fail('area_delete_cloud_purge_pending', 'The cloud purge is not yet complete');
    await this.store.progressAreaDeletion(job.operationId, { complete: true });
    await this.store.commit(state => { delete state.areaDeletionIntents?.[job.operationId]; });
    this.previews.delete(job.operationId);
    return { operationId: job.operationId, state: 'COMPLETE', providerDetachments: job.providerDetachments || 0 };
  }
}
module.exports = { AreaDeletionService };
