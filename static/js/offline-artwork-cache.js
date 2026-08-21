export const OFFLINE_ARTWORK_CACHE_NAME = 'feedback-offline-artwork-v1';

export function normalizeOfflineArtworkFilename(value) {
    if (typeof value !== 'string') return '';
    if (!value) return '';
    try { return decodeURIComponent(value); } catch { return value; }
}

export function buildOfflineArtworkUrl(
    filename,
    baseHref = globalThis.location?.href || 'http://localhost/',
) {
    const normalized = normalizeOfflineArtworkFilename(filename);
    if (!normalized) throw new TypeError('offline artwork filename is required');
    const base = new URL(baseHref);
    const url = new URL(`/api/song/${encodeURIComponent(normalized)}/art`, base);
    if (url.origin !== base.origin) throw new TypeError('offline artwork URL must be same-origin');
    return url.href;
}

function isImageResponse(response) {
    const mediaType = response?.headers?.get?.('content-type') || '';
    return Boolean(response?.ok) && mediaType.toLowerCase().startsWith('image/');
}

export function createOfflineArtworkCache({
    cacheStorage = globalThis.caches,
    fetch: fetchRef = globalThis.fetch,
    Request: RequestClass = globalThis.Request,
    baseHref = globalThis.location?.href || 'http://localhost/',
} = {}) {
    const captures = new Map();

    function requestFor(filename) {
        if (!cacheStorage || typeof cacheStorage.open !== 'function') {
            throw new Error('Cache Storage is unavailable');
        }
        if (typeof RequestClass !== 'function') throw new Error('Request is unavailable');
        return new RequestClass(buildOfflineArtworkUrl(filename, baseHref), {
            method: 'GET',
            cache: 'no-store',
        });
    }

    async function read(filename) {
        try {
            const cache = await cacheStorage.open(OFFLINE_ARTWORK_CACHE_NAME);
            const response = await cache.match(requestFor(filename));
            return isImageResponse(response) ? response : null;
        } catch {
            return null;
        }
    }

    async function captureOnce(filename) {
        try {
            const request = requestFor(filename);
            const cache = await cacheStorage.open(OFFLINE_ARTWORK_CACHE_NAME);
            const existing = await cache.match(request);
            if (isImageResponse(existing)) return true;
            if (typeof fetchRef !== 'function') return false;
            const response = await fetchRef(request);
            if (!isImageResponse(response)) return false;
            await cache.put(request, response.clone());
            return true;
        } catch {
            return false;
        }
    }

    function capture(filename) {
        let key;
        try { key = buildOfflineArtworkUrl(filename, baseHref); } catch { return Promise.resolve(false); }
        if (captures.has(key)) return captures.get(key);
        const pending = captureOnce(filename).finally(() => captures.delete(key));
        captures.set(key, pending);
        return pending;
    }

    async function remove(filename) {
        const cache = await cacheStorage.open(OFFLINE_ARTWORK_CACHE_NAME);
        return cache.delete(requestFor(filename));
    }

    return Object.freeze({ capture, read, remove });
}

const defaultArtworkCache = createOfflineArtworkCache();

export const cacheOfflineArtwork = defaultArtworkCache.capture;
export const readOfflineArtwork = defaultArtworkCache.read;
export const deleteOfflineArtwork = defaultArtworkCache.remove;
