export const AVAILABILITY_STATES = Object.freeze({
    CHECKING: 'checking',
    ONLINE: 'online',
    CACHED_SHELL: 'cached-shell',
    SERVER_UNAVAILABLE: 'server-unavailable',
});

const DEFAULT_TIMEOUT_MS = 5000;

function defaultFetch(...args) {
    return globalThis.fetch(...args);
}

export function createAppAvailability({
    fetch: fetchImpl = defaultFetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    AbortController: AbortControllerImpl = globalThis.AbortController,
    scheduleTimeout = globalThis.setTimeout,
    cancelTimeout = globalThis.clearTimeout,
} = {}) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new TypeError('timeoutMs must be a positive finite number');
    }

    let state = AVAILABILITY_STATES.CHECKING;
    let wasOnline = false;
    let activeProbe = null;
    const listeners = new Set();

    function snapshot() {
        return Object.freeze({ state });
    }

    function publish(nextState) {
        if (state === nextState) return;
        state = nextState;
        const nextSnapshot = snapshot();
        for (const listener of listeners) {
            try {
                listener(nextSnapshot);
            } catch (_) {
                // Availability ownership must not depend on subscriber behavior.
            }
        }
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') {
            throw new TypeError('listener must be a function');
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    function publishProbeResult(succeeded) {
        if (succeeded) {
            wasOnline = true;
            publish(AVAILABILITY_STATES.ONLINE);
            return;
        }
        publish(wasOnline
            ? AVAILABILITY_STATES.SERVER_UNAVAILABLE
            : AVAILABILITY_STATES.CACHED_SHELL);
    }

    async function runProbe() {
        let timeoutToken;
        try {
            const controller = new AbortControllerImpl();
            const timeoutResult = Symbol('availability-timeout');
            const timeoutPromise = new Promise((resolve) => {
                timeoutToken = scheduleTimeout(() => {
                    try {
                        controller.abort();
                    } finally {
                        resolve(timeoutResult);
                    }
                }, timeoutMs);
            });
            const request = Promise.resolve().then(() => fetchImpl('/api/version', {
                method: 'GET',
                cache: 'no-store',
                credentials: 'same-origin',
                signal: controller.signal,
            }));
            const response = await Promise.race([request, timeoutPromise]);
            publishProbeResult(response !== timeoutResult && Boolean(response?.ok));
        } catch (_) {
            publishProbeResult(false);
        } finally {
            if (timeoutToken !== undefined) cancelTimeout(timeoutToken);
        }
        return snapshot();
    }

    function check() {
        if (activeProbe) return activeProbe;
        activeProbe = runProbe().finally(() => {
            activeProbe = null;
        });
        return activeProbe;
    }

    return Object.freeze({
        snapshot,
        subscribe,
        check,
    });
}

const appAvailability = createAppAvailability();

export const getAvailabilitySnapshot = appAvailability.snapshot;
export const subscribeAvailability = appAvailability.subscribe;
export const checkAvailability = appAvailability.check;
