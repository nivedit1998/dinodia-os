# Universal category analytics — candidate, activation held

Canonical category, lifecycle, Home, owner and one selected control come from
the signed Platform policy. Manufacturer/model is not an eligibility rule.
Radiator means observed heat demand; Boiler means actual heat production;
Light uses observable power ahead of remembered brightness. Unsupported or
ambiguous signals remain Unknown. No gas volume or cost is inferred.

## Collection and provenance

The real MQTT path resolves the exact endpoint, reads existing reporting
configuration, correlates the response and verifies cadence. Generic profiles
never configure a device automatically. The earlier explicitly approved TRV
profile remains separately constrained. Generic admission additionally requires
both file and effective bridge/info options: ISO last_seen, optimistic false,
filtered_cache for the selected property, and no pending publisher restart.
Retained messages, cached siblings, nulls and stale timestamps cannot renew it.
Known mains defaults to a 300 s reporting maximum; unknown power is conservative
like battery (600 s maximum). Verified maximum plus 60 s delivery grace may
shorten, never extend, an already-stamped sample. Existing declared validity
also caps a new sample.

The bounded-read coordinator persists intent before dispatch, limits to 12
operations/hour/device, 10 s Hub spacing, one outstanding request, 300 s per
value, 30 s timeout inside 360 s validity, and never automatically resends a
command. It rechecks policy after a response. Installed integrations have no
proven correlated network-read adapter here: the production adapter map is
empty. Matter and provider readiness explicitly report this limitation. Test
adapter success is NOT evidence of a live Matter, Hive or Nest read.

## Accounting

The interval id/revision and generation in the signed policy identify v2
sources/buckets. Source changes and switch-back within one hour cannot collide.
A policy change stops the prior source at local receipt; the cloud's immediate
effective time is authoritative. Any aggregate straddling that earlier boundary
is preserved intact by Platform as unallocated, not guessed or split. Old-format
keys are unchanged. After a v2 source exists, this code never silently resumes
the legacy writer. Clock trust, alive markers, critical writes, command receipts,
outbox acknowledgement and Store recovery safeguards remain in force.

## Release restrictions

This candidate has not been installed. Server-owned analyticsWriterEnabled and
analyticsCollectionEnabled both default false; Hub capabilities cannot enable
them. Install only after compatible Platform schema/code/readiness verification.
The generic reporting write permission has NOT been granted. No physical device
acceptance is claimed. After v2 activation, prefer forward recovery with flags
off; never restore an old Store or assume old Platform understands interval rows.
The workspace release manifest defines exact artifacts and the approval gate.
