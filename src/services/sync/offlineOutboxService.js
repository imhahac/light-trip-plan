/**
 * offlineOutboxService.js
 * Offline-First Write Queue (Outbox) with X-Idempotency-Key replay & Keep-Mine / Keep-Theirs conflict detection.
 */

import { syncOutboxRepo } from '../db';
import { pullFromIngestApi, setLastSyncedRevision } from '../api/ingestApiService';
import { isEffectivelyOffline } from './offlineModeService';

function generateIdempotencyKey() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `idem_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    }
    return `idem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Enqueue a change into the device-local IndexedDB syncOutbox.
 */
export async function enqueueOfflineWrite({ channel = 'default', mode = 'merge', payload, baseRevision = 0, label = '離線變更' }) {
    const idempotencyKey = generateIdempotencyKey();
    const entry = {
        id: `outbox_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        idempotencyKey,
        channel,
        mode,
        payload,
        baseRevision: Number(baseRevision) || 0,
        label,
        status: 'pending',
        createdAt: Date.now(),
    };
    await syncOutboxRepo.save(entry);
    return entry;
}

/**
 * Push a single outbox item to the Worker with X-Idempotency-Key header.
 */
export async function pushOutboxItemWithIdempotency({ endpointUrl, apiToken, item }) {
    const base = String(endpointUrl || '').replace(/\/+$/, '');
    const channel = encodeURIComponent(item.channel || 'default');
    const mode = item.mode === 'replace' ? 'replace' : 'merge';
    const res = await fetch(`${base}/api/v1/ingest?channel=${channel}&mode=${mode}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiToken}`,
            'X-Idempotency-Key': item.idempotencyKey,
        },
        body: JSON.stringify(item.payload || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
    }
    if (Number.isFinite(Number(data.revision))) {
        setLastSyncedRevision(item.channel || 'default', Number(data.revision));
    }
    return data;
}

/**
 * Flush all pending offline writes.
 * If remote revision > item.baseRevision, pauses and returns { conflicts: [{ item, remote }] }
 * so the UI can let the user choose Keep Mine or Keep Theirs.
 */
export async function flushOfflineOutbox({ endpointUrl, apiToken, forceKeepMine = false }) {
    if (isEffectivelyOffline()) {
        return { flushed: 0, conflicts: [], skippedOffline: true };
    }
    if (!endpointUrl || !apiToken) {
        return { flushed: 0, conflicts: [], skippedUnconfigured: true };
    }

    const pending = await syncOutboxRepo.getPending();
    pending.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

    let flushed = 0;
    const conflicts = [];

    for (const item of pending) {
        if (!forceKeepMine && item.baseRevision > 0) {
            const remote = await pullFromIngestApi({
                endpointUrl,
                apiToken,
                channel: item.channel,
                sinceRevision: item.baseRevision,
            });
            if (remote?.hasUpdate && Number(remote.revision) > item.baseRevision) {
                conflicts.push({ item, remote });
                continue;
            }
        }

        await pushOutboxItemWithIdempotency({ endpointUrl, apiToken, item });
        await syncOutboxRepo.delete(item.id);
        flushed++;
    }

    return { flushed, conflicts };
}

/**
 * Resolve a single conflict item:
 * - 'keep-mine': force push local outbox item with its X-Idempotency-Key
 * - 'keep-theirs': discard local outbox item and return remote.data for caller to import
 */
export async function resolveOutboxConflict({ choice, conflict, endpointUrl, apiToken }) {
    const { item, remote } = conflict;
    if (choice === 'keep-mine') {
        const res = await pushOutboxItemWithIdempotency({ endpointUrl, apiToken, item });
        await syncOutboxRepo.delete(item.id);
        return { resolved: 'keep-mine', result: res };
    }
    await syncOutboxRepo.delete(item.id);
    if (Number.isFinite(Number(remote?.revision))) {
        setLastSyncedRevision(item.channel || 'default', Number(remote.revision));
    }
    return { resolved: 'keep-theirs', remoteData: remote?.data || null };
}
