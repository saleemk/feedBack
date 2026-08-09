export const DEVICE_CATALOG_DB_NAME = 'feedback-device-catalog';
export const DEVICE_CATALOG_DB_VERSION = 1;
export const DEVICE_CATALOG_STORE_NAME = 'songs';

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

function requireOwnString(record, field) {
    if (!Object.prototype.hasOwnProperty.call(record, field)
            || typeof record[field] !== 'string') {
        throw new TypeError(`song ${field} must be an own string property`);
    }
    return record[field];
}

function copySong(record) {
    if (!record || typeof record !== 'object') {
        throw new TypeError('song must be an object');
    }
    const id = requireOwnString(record, 'id');
    if (!id.trim()) throw new TypeError('song id must be non-empty');
    return {
        id,
        title: requireOwnString(record, 'title'),
        artist: requireOwnString(record, 'artist'),
    };
}

function requireSongId(id) {
    if (typeof id !== 'string' || !id.trim()) {
        throw new TypeError('song id must be a non-empty string');
    }
    return id;
}

function compareSongIds(left, right) {
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
}

export function createDeviceCatalog({ indexedDB = globalThis.indexedDB } = {}) {
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
                if (!db.objectStoreNames.contains(DEVICE_CATALOG_STORE_NAME)) {
                    db.close();
                    fail('The device catalog store is unavailable');
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

    function transact(mode, startRequest, projectResult) {
        return open().then((db) => new Promise((resolve, reject) => {
            let transaction;
            let request;
            let settled = false;
            const fail = (message, cause) => {
                if (settled) return;
                settled = true;
                reject(unavailable(message, cause));
            };

            try {
                transaction = db.transaction(DEVICE_CATALOG_STORE_NAME, mode);
                request = startRequest(transaction.objectStore(DEVICE_CATALOG_STORE_NAME));
            } catch (error) {
                fail('Unable to start a device catalog transaction', error);
                return;
            }

            request.onerror = () => fail('Device catalog request failed', request.error);
            transaction.onerror = () => fail(
                'Device catalog transaction failed',
                transaction.error,
            );
            transaction.onabort = () => fail(
                'Device catalog transaction was aborted',
                transaction.error,
            );
            transaction.oncomplete = () => {
                if (settled) return;
                try {
                    const result = projectResult(request.result);
                    settled = true;
                    resolve(result);
                } catch (error) {
                    settled = true;
                    reject(error);
                }
            };
        }));
    }

    function list() {
        return transact('readonly', (store) => store.getAll(), (records) => (
            records.map(copySong).sort(compareSongIds)
        ));
    }

    function count() {
        return transact('readonly', (store) => store.count(), (value) => value);
    }

    function put(record) {
        const song = copySong(record);
        return transact('readwrite', (store) => store.put(song), () => copySong(song));
    }

    function remove(id) {
        const songId = requireSongId(id);
        return transact('readwrite', (store) => store.delete(songId), () => undefined);
    }

    function clear() {
        return transact('readwrite', (store) => store.clear(), () => undefined);
    }

    return Object.freeze({ open, list, count, put, remove, clear });
}

const deviceCatalog = createDeviceCatalog();

export const openDeviceCatalog = deviceCatalog.open;
export const listDeviceSongs = deviceCatalog.list;
export const countDeviceSongs = deviceCatalog.count;
export const putDeviceSong = deviceCatalog.put;
export const removeDeviceSong = deviceCatalog.remove;
export const clearDeviceSongs = deviceCatalog.clear;
