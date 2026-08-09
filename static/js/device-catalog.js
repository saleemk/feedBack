export const DEVICE_CATALOG_DB_NAME = 'feedback-device-catalog';
export const DEVICE_CATALOG_DB_VERSION = 2;
export const DEVICE_CATALOG_STORE_NAME = 'songs';
export const DEVICE_CATALOG_SNAPSHOT_STORE_NAME = 'snapshots';

const CURRENT_SNAPSHOT_KEY = 'current';
const SNAPSHOT_SCHEMA = 'feedback.device-catalog.snapshot.v1';
const SNAPSHOT_SOURCE = 'local';
const MAX_TEXT_CHARACTERS = 512;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export class CatalogUnavailableError extends Error {
    constructor(message, cause = null) {
        super(message);
        this.name = 'CatalogUnavailableError';
        if (cause) this.cause = cause;
    }
}

function unavailable(message, cause = null) {
    if (cause instanceof CatalogUnavailableError) return cause;
    return new CatalogUnavailableError(message, cause);
}

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireOwn(record, field, label) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
        throw new TypeError(`${label} ${field} must be an own property`);
    }
    return record[field];
}

function requireOwnString(record, field, label) {
    const value = requireOwn(record, field, label);
    if (typeof value !== 'string') {
        throw new TypeError(`${label} ${field} must be a string`);
    }
    return value;
}

function requireSha256(value, label) {
    if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
        throw new TypeError(`${label} must be lowercase 64-character SHA-256 hex`);
    }
    return value;
}

function requireNonNegativeSafeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }
    return value;
}

function copySong(record) {
    if (!isRecord(record)) throw new TypeError('song must be an object');
    const id = requireSha256(requireOwnString(record, 'id', 'song'), 'song id');
    const title = requireOwnString(record, 'title', 'song');
    const artist = requireOwnString(record, 'artist', 'song');
    if (Array.from(title).length > MAX_TEXT_CHARACTERS) {
        throw new TypeError(`song title must not exceed ${MAX_TEXT_CHARACTERS} characters`);
    }
    if (Array.from(artist).length > MAX_TEXT_CHARACTERS) {
        throw new TypeError(`song artist must not exceed ${MAX_TEXT_CHARACTERS} characters`);
    }
    return { id, title, artist };
}

function compareSongIds(left, right) {
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
}

function copySongs(records) {
    if (!Array.isArray(records)) throw new TypeError('snapshot songs must be an array');
    const ids = new Set();
    const songs = records.map((record) => {
        const song = copySong(record);
        if (ids.has(song.id)) throw new TypeError(`duplicate song id: ${song.id}`);
        ids.add(song.id);
        return song;
    });
    return songs.sort(compareSongIds);
}

function copyMetadata(record, { requireComplete = false } = {}) {
    if (!isRecord(record)) throw new TypeError('snapshot metadata must be an object');
    if (requireComplete && requireOwn(record, 'key', 'snapshot metadata') !== CURRENT_SNAPSHOT_KEY) {
        throw new TypeError('snapshot metadata key must be current');
    }
    const schema = requireOwnString(record, 'schema', 'snapshot metadata');
    const source = requireOwnString(record, 'source', 'snapshot metadata');
    if (schema !== SNAPSHOT_SCHEMA) throw new TypeError(`snapshot schema must be ${SNAPSHOT_SCHEMA}`);
    if (source !== SNAPSHOT_SOURCE) throw new TypeError(`snapshot source must be ${SNAPSHOT_SOURCE}`);
    const revision = requireSha256(
        requireOwnString(record, 'revision', 'snapshot metadata'),
        'snapshot revision',
    );
    const count = requireNonNegativeSafeInteger(
        requireOwn(record, 'count', 'snapshot metadata'),
        'snapshot count',
    );
    const total = requireNonNegativeSafeInteger(
        requireOwn(record, 'total', 'snapshot metadata'),
        'snapshot total',
    );
    if (count !== total) throw new TypeError('snapshot count must equal total');

    const metadata = { schema, source, revision, count, total };
    if (requireComplete) {
        const capturedAt = requireNonNegativeSafeInteger(
            requireOwn(record, 'capturedAt', 'snapshot metadata'),
            'snapshot capturedAt',
        );
        if (requireOwn(record, 'complete', 'snapshot metadata') !== true) {
            throw new TypeError('snapshot metadata complete must be true');
        }
        return {
            key: CURRENT_SNAPSHOT_KEY,
            ...metadata,
            capturedAt,
            complete: true,
        };
    }
    return metadata;
}

function validateCount(metadata, songs) {
    if (metadata.count !== songs.length) {
        throw new TypeError('snapshot count must equal songs length');
    }
}

function copyPublishedSnapshot(metadata, songs) {
    return {
        metadata: { ...metadata },
        songs: songs.map((song) => ({ ...song })),
    };
}

export function createDeviceCatalog({
    indexedDB = globalThis.indexedDB,
    now = Date.now,
} = {}) {
    let database = null;
    let opening = null;

    function open() {
        if (database) return Promise.resolve(database);
        if (opening) return opening;
        if (!indexedDB || typeof indexedDB.open !== 'function') {
            return Promise.reject(unavailable('IndexedDB is unavailable'));
        }

        opening = new Promise((resolve, reject) => {
            let settled = false;
            let request;
            const fail = (message, cause) => {
                if (settled) return;
                settled = true;
                reject(unavailable(message, cause));
            };

            try {
                request = indexedDB.open(
                    DEVICE_CATALOG_DB_NAME,
                    DEVICE_CATALOG_DB_VERSION,
                );
            } catch (error) {
                fail('Unable to open the device catalog', error);
                return;
            }

            request.onupgradeneeded = () => {
                try {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(DEVICE_CATALOG_STORE_NAME)) {
                        db.createObjectStore(DEVICE_CATALOG_STORE_NAME, { keyPath: 'id' });
                    }
                    if (!db.objectStoreNames.contains(DEVICE_CATALOG_SNAPSHOT_STORE_NAME)) {
                        db.createObjectStore(
                            DEVICE_CATALOG_SNAPSHOT_STORE_NAME,
                            { keyPath: 'key' },
                        );
                    }
                } catch (error) {
                    try {
                        request.transaction?.abort();
                    } catch (_) {
                        // The original upgrade error is more useful.
                    }
                    fail('Unable to create the device catalog', error);
                }
            };
            request.onerror = () => fail(
                'Unable to open the device catalog',
                request.error,
            );
            request.onblocked = () => fail('Opening the device catalog was blocked');
            request.onsuccess = () => {
                if (settled) {
                    request.result.close();
                    return;
                }
                const db = request.result;
                const hasSongs = db.objectStoreNames.contains(DEVICE_CATALOG_STORE_NAME);
                const hasSnapshots = db.objectStoreNames.contains(
                    DEVICE_CATALOG_SNAPSHOT_STORE_NAME,
                );
                if (!hasSongs || !hasSnapshots) {
                    db.close();
                    fail('The device catalog stores are unavailable');
                    return;
                }
                settled = true;
                database = db;
                database.onversionchange = () => {
                    database.close();
                    database = null;
                    opening = null;
                };
                resolve(database);
            };
        }).catch((error) => {
            opening = null;
            throw error;
        });
        return opening;
    }

    function runTransaction(mode, operation, projectResult) {
        return open().then((db) => new Promise((resolve, reject) => {
            let transaction;
            let values;
            let synchronousError = null;
            let settled = false;
            const fail = (message, cause) => {
                if (settled) return;
                settled = true;
                reject(unavailable(message, cause));
            };

            try {
                transaction = db.transaction(
                    [DEVICE_CATALOG_STORE_NAME, DEVICE_CATALOG_SNAPSHOT_STORE_NAME],
                    mode,
                );
                values = operation(transaction);
            } catch (error) {
                synchronousError = error;
                try {
                    transaction?.abort();
                } catch (_) {
                    fail('Unable to start a device catalog transaction', error);
                }
                if (!transaction) fail('Unable to start a device catalog transaction', error);
            }

            if (!transaction) return;
            transaction.onerror = () => {
                // IndexedDB request errors abort by default; settle on the terminal abort.
            };
            transaction.onabort = () => fail(
                'Device catalog transaction was aborted',
                synchronousError || transaction.error,
            );
            transaction.oncomplete = () => {
                if (settled) return;
                try {
                    const result = projectResult(values);
                    settled = true;
                    resolve(result);
                } catch (error) {
                    settled = true;
                    reject(error);
                }
            };
        }));
    }

    function replaceSnapshot(snapshot, { capturedAt } = {}) {
        if (!isRecord(snapshot)) throw new TypeError('snapshot must be an object');
        if (Object.prototype.hasOwnProperty.call(snapshot, 'capturedAt')) {
            throw new TypeError('snapshot capturedAt is browser-owned');
        }
        if (Object.prototype.hasOwnProperty.call(snapshot, 'complete')
                && snapshot.complete !== true) {
            throw new TypeError('snapshot complete must not conflict with a complete generation');
        }
        const baseMetadata = copyMetadata(snapshot);
        const songs = copySongs(requireOwn(snapshot, 'songs', 'snapshot'));
        validateCount(baseMetadata, songs);
        const captureTime = requireNonNegativeSafeInteger(
            capturedAt === undefined ? now() : capturedAt,
            'snapshot capturedAt',
        );
        const metadata = {
            key: CURRENT_SNAPSHOT_KEY,
            ...baseMetadata,
            capturedAt: captureTime,
            complete: true,
        };

        return runTransaction('readwrite', (transaction) => {
            const songStore = transaction.objectStore(DEVICE_CATALOG_STORE_NAME);
            const snapshotStore = transaction.objectStore(
                DEVICE_CATALOG_SNAPSHOT_STORE_NAME,
            );
            songStore.clear();
            songs.forEach((song) => songStore.put(song));
            snapshotStore.put(metadata);
        }, () => copyPublishedSnapshot(metadata, songs));
    }

    function readSnapshot() {
        return runTransaction('readonly', (transaction) => {
            const metadataRequest = transaction
                .objectStore(DEVICE_CATALOG_SNAPSHOT_STORE_NAME)
                .get(CURRENT_SNAPSHOT_KEY);
            const songsRequest = transaction
                .objectStore(DEVICE_CATALOG_STORE_NAME)
                .getAll();
            return { metadataRequest, songsRequest };
        }, ({ metadataRequest, songsRequest }) => {
            if (metadataRequest.result === undefined) return null;
            try {
                const metadata = copyMetadata(metadataRequest.result, { requireComplete: true });
                const songs = copySongs(songsRequest.result);
                validateCount(metadata, songs);
                return copyPublishedSnapshot(metadata, songs);
            } catch (error) {
                throw unavailable('The device catalog snapshot is invalid', error);
            }
        });
    }

    return Object.freeze({ open, replaceSnapshot, readSnapshot });
}

const deviceCatalog = createDeviceCatalog();

export const openDeviceCatalog = deviceCatalog.open;
export const replaceDeviceCatalogSnapshot = deviceCatalog.replaceSnapshot;
export const readDeviceCatalogSnapshot = deviceCatalog.readSnapshot;
