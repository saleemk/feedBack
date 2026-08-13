const REVISION_RE = /^[0-9a-f]{64}$/;
export const OFFLINE_RECOVERY_URL = '/static/v3/offline.html';

export function consumeOfflineLaunchIntent({
    location: locationRef = globalThis.location,
    history: historyRef = globalThis.history,
} = {}) {
    let url;
    try {
        url = new URL(locationRef.href);
    } catch (_) {
        return Object.freeze({ active: false, revision: null });
    }
    if (url.searchParams.get('offline') !== '1') {
        return Object.freeze({ active: false, revision: null });
    }

    const requestedRevision = url.searchParams.get('revision');
    if (requestedRevision !== null) {
        url.searchParams.delete('revision');
        historyRef.replaceState(
            historyRef.state ?? null,
            '',
            `${url.pathname}${url.search}${url.hash}`,
        );
    }
    const revision = REVISION_RE.test(requestedRevision || '') ? requestedRevision : null;
    return Object.freeze({ active: true, revision });
}

export function returnToOfflineRecovery(locationRef = globalThis.location) {
    locationRef.replace(OFFLINE_RECOVERY_URL);
}
