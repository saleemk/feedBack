import {
    AVAILABILITY_STATES,
    checkAvailability,
} from './app-availability.js';
import { replaceDeviceCatalogSnapshot } from './device-catalog.js';

const DEFAULT_DEBOUNCE_MS = 500;
const REQUEST_OPTIONS = Object.freeze({
    cache: 'no-store',
    credentials: 'same-origin',
});

function defaultFetch(...args) {
    return globalThis.fetch(...args);
}

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function createDeviceCatalogCapture({
    availabilityCheck = checkAvailability,
    fetch: fetchImpl = defaultFetch,
    replaceSnapshot = replaceDeviceCatalogSnapshot,
    eventBus = globalThis.window?.feedBack,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    scheduleTimeout = globalThis.setTimeout,
    cancelTimeout = globalThis.clearTimeout,
} = {}) {
    if (!Number.isFinite(debounceMs) || debounceMs < 0) {
        throw new TypeError('debounceMs must be a non-negative finite number');
    }

    let started = false;
    let stopped = false;
    let activeAttempt = null;
    let followUpRequested = false;
    let debounceToken = null;
    let listenerAttached = false;

    async function captureOnce() {
        const availability = await availabilityCheck();
        if (availability?.state !== AVAILABILITY_STATES.ONLINE) return false;

        const scanResponse = await fetchImpl('/api/scan-status', REQUEST_OPTIONS);
        if (!scanResponse?.ok) return false;
        const scanStatus = await scanResponse.json();
        if (!isRecord(scanStatus)
                || typeof scanStatus.running !== 'boolean'
                || scanStatus.running
                || scanStatus.error
                || scanStatus.stage === 'error') {
            return false;
        }

        const catalogResponse = await fetchImpl(
            '/api/library/device-catalog',
            REQUEST_OPTIONS,
        );
        if (!catalogResponse?.ok) return false;
        const snapshot = await catalogResponse.json();
        await replaceSnapshot(snapshot);
        return true;
    }

    function requestCapture() {
        if (stopped) return Promise.resolve(false);
        if (activeAttempt) {
            followUpRequested = true;
            return activeAttempt;
        }

        const attempt = Promise.resolve()
            .then(captureOnce)
            .catch(() => false);
        activeAttempt = attempt;
        void attempt.finally(() => {
            activeAttempt = null;
            if (!followUpRequested || stopped) return;
            followUpRequested = false;
            void requestCapture();
        });
        return attempt;
    }

    function scheduleCapture() {
        if (stopped) return;
        if (activeAttempt) {
            followUpRequested = true;
            return;
        }
        if (debounceToken !== null) cancelTimeout(debounceToken);
        debounceToken = scheduleTimeout(() => {
            debounceToken = null;
            void requestCapture();
        }, debounceMs);
    }

    function attachListener() {
        if (typeof eventBus?.on === 'function' && typeof eventBus?.off === 'function') {
            eventBus.on('library:changed', scheduleCapture);
            listenerAttached = true;
            return;
        }
        if (typeof eventBus?.addEventListener === 'function'
                && typeof eventBus?.removeEventListener === 'function') {
            eventBus.addEventListener('library:changed', scheduleCapture);
            listenerAttached = true;
        }
    }

    function start() {
        if (started || stopped) return cleanup;
        started = true;
        try {
            attachListener();
        } catch (_) {
            listenerAttached = false;
        }
        void requestCapture();
        return cleanup;
    }

    function cleanup() {
        if (stopped) return;
        stopped = true;
        followUpRequested = false;
        if (debounceToken !== null) {
            cancelTimeout(debounceToken);
            debounceToken = null;
        }
        if (!listenerAttached) return;
        listenerAttached = false;
        try {
            if (typeof eventBus?.off === 'function') {
                eventBus.off('library:changed', scheduleCapture);
            } else {
                eventBus?.removeEventListener?.('library:changed', scheduleCapture);
            }
        } catch (_) {
            // Cleanup remains idempotent even if the event owner is tearing down.
        }
    }

    return Object.freeze({ start, cleanup, requestCapture });
}

let activeCapture = null;

export function startDeviceCatalogCapture(eventBus = globalThis.window?.feedBack) {
    if (!activeCapture) activeCapture = createDeviceCatalogCapture({ eventBus });
    return activeCapture.start();
}
