'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.join(
    __dirname,
    '..',
    '..',
    'static',
    'js',
    'device-catalog.js',
);
let importSerial = 0;

async function loadModule() {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    const encoded = Buffer.from(source).toString('base64');
    importSerial += 1;
    return import(`data:text/javascript;base64,${encoded}#${importSerial}`);
}

function createFakeIndexedDB({ openError = false } = {}) {
    const stores = new Map();
    const pendingCompletions = [];
    const state = {
        openCalls: 0,
        upgrades: 0,
        name: null,
        version: null,
        nextTransactionFailure: null,
        holdCompletions: false,
    };
    let created = false;

    function clone(value) {
        return value && typeof value === 'object' ? { ...value } : value;
    }

    function finishTransaction(transaction) {
        const complete = () => queueMicrotask(() => transaction.oncomplete?.());
        if (state.holdCompletions) pendingCompletions.push(complete);
        else complete();
    }

    function createTransaction(store) {
        const failure = state.nextTransactionFailure;
        state.nextTransactionFailure = null;
        const transaction = {
            error: null,
            objectStore() {
                const request = (operation) => {
                    const result = {};
                    queueMicrotask(() => {
                        if (failure) {
                            const error = new Error(`transaction ${failure}`);
                            result.error = error;
                            transaction.error = error;
                            if (failure === 'abort') transaction.onabort?.();
                            else {
                                result.onerror?.();
                                transaction.onerror?.();
                            }
                            return;
                        }
                        try {
                            result.result = operation();
                            result.onsuccess?.();
                            finishTransaction(transaction);
                        } catch (error) {
                            result.error = error;
                            transaction.error = error;
                            result.onerror?.();
                            transaction.onerror?.();
                        }
                    });
                    return result;
                };
                return {
                    getAll: () => request(() => Array.from(store.values(), clone)),
                    count: () => request(() => store.size),
                    put: (record) => request(() => {
                        store.set(record.id, clone(record));
                        return record.id;
                    }),
                    delete: (id) => request(() => store.delete(id)),
                    clear: () => request(() => store.clear()),
                };
            },
        };
        return transaction;
    }

    const database = {
        objectStoreNames: { contains: (name) => stores.has(name) },
        createObjectStore(name, options) {
            assert.deepEqual(options, { keyPath: 'id' });
            stores.set(name, new Map());
        },
        transaction(name) {
            const store = stores.get(name);
            if (!store) throw new Error('missing store');
            return createTransaction(store);
        },
        close() {},
        onversionchange: null,
    };

    const indexedDB = {
        open(name, version) {
            state.openCalls += 1;
            state.name = name;
            state.version = version;
            const request = { result: database, error: null, transaction: { abort() {} } };
            queueMicrotask(() => {
                if (openError) {
                    request.error = new Error('open failed');
                    request.onerror?.();
                    return;
                }
                if (!created) {
                    state.upgrades += 1;
                    request.onupgradeneeded?.();
                    created = true;
                }
                request.onsuccess?.();
            });
            return request;
        },
    };

    return {
        indexedDB,
        state,
        failNextTransaction(kind) { state.nextTransactionFailure = kind; },
        releaseCompletions() {
            state.holdCompletions = false;
            pendingCompletions.splice(0).forEach((complete) => complete());
        },
    };
}

test('catalog opens lazily, coalesces opening, and creates only the version-1 songs store', async () => {
    const module = await loadModule();
    const fake = createFakeIndexedDB();
    const catalog = module.createDeviceCatalog({ indexedDB: fake.indexedDB });

    assert.equal(fake.state.openCalls, 0);
    const first = catalog.open();
    const second = catalog.open();
    assert.equal(first, second);
    await first;

    assert.equal(fake.state.openCalls, 1);
    assert.equal(fake.state.upgrades, 1);
    assert.equal(fake.state.name, 'feedback-device-catalog');
    assert.equal(fake.state.version, 1);
    assert.deepEqual(await catalog.list(), []);
    assert.equal(await catalog.count(), 0);
    assert.equal(fake.state.openCalls, 1);
});

test('catalog validates and copies records, sorts deterministically, and supports replacement', async () => {
    const module = await loadModule();
    const fake = createFakeIndexedDB();
    const catalog = module.createDeviceCatalog({ indexedDB: fake.indexedDB });
    const input = Object.assign(Object.create({ bundle: 'not stored' }), {
        id: 'song-b',
        title: 'Beta',
        artist: 'Artist B',
        artwork: 'not stored',
    });

    const putting = catalog.put(input);
    input.title = 'caller mutation';
    const accepted = await putting;
    accepted.artist = 'result mutation';
    await catalog.put({ id: 'song-a', title: 'Alpha', artist: 'Artist A' });
    await catalog.put({ id: 'song-b', title: 'Beta 2', artist: 'Artist B' });

    assert.equal(await catalog.count(), 2);
    assert.deepEqual(await catalog.list(), [
        { id: 'song-a', title: 'Alpha', artist: 'Artist A' },
        { id: 'song-b', title: 'Beta 2', artist: 'Artist B' },
    ]);
    assert.throws(() => catalog.put({ id: ' ', title: 'No ID', artist: 'Artist' }), TypeError);
    assert.throws(() => catalog.put(Object.assign(
        Object.create({ id: 'inherited' }),
        { title: 'Title', artist: 'Artist' },
    )), TypeError);
});

test('remove and clear update the catalog only after transaction completion', async () => {
    const module = await loadModule();
    const fake = createFakeIndexedDB();
    const catalog = module.createDeviceCatalog({ indexedDB: fake.indexedDB });
    await catalog.put({ id: 'song-a', title: 'Alpha', artist: 'Artist' });

    fake.state.holdCompletions = true;
    let settled = false;
    const removing = catalog.remove('song-a').finally(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    fake.releaseCompletions();
    await removing;
    assert.equal(await catalog.count(), 0);

    await catalog.put({ id: 'song-b', title: 'Beta', artist: 'Artist' });
    await catalog.clear();
    assert.deepEqual(await catalog.list(), []);
});

test('transaction errors and aborts surface as catalog-unavailable errors', async () => {
    const module = await loadModule();
    const fake = createFakeIndexedDB();
    const catalog = module.createDeviceCatalog({ indexedDB: fake.indexedDB });

    fake.failNextTransaction('error');
    await assert.rejects(catalog.count(), module.CatalogUnavailableError);
    fake.failNextTransaction('abort');
    await assert.rejects(catalog.list(), module.CatalogUnavailableError);
});

test('missing or failed IndexedDB is explicit rather than an empty catalog', async () => {
    const module = await loadModule();
    const missing = module.createDeviceCatalog({ indexedDB: null });
    await assert.rejects(missing.list(), module.CatalogUnavailableError);

    const fake = createFakeIndexedDB({ openError: true });
    const failed = module.createDeviceCatalog({ indexedDB: fake.indexedDB });
    await assert.rejects(failed.count(), module.CatalogUnavailableError);
});
