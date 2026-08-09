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
const SCHEMA = 'feedback.device-catalog.snapshot.v1';
const REVISION = 'f'.repeat(64);
const SONG_A = 'a'.repeat(64);
const SONG_B = 'b'.repeat(64);
let importSerial = 0;

async function loadModule() {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    const encoded = Buffer.from(source).toString('base64');
    importSerial += 1;
    return import(`data:text/javascript;base64,${encoded}#${importSerial}`);
}

function clone(value) {
    return value && typeof value === 'object' ? { ...value } : value;
}

function cloneStore(store) {
    return new Map(Array.from(store, ([key, value]) => [key, clone(value)]));
}

function createFakeIndexedDB({
    openError = false,
    blocked = false,
    version = 0,
    initialStores = {},
} = {}) {
    const stores = new Map();
    const keyPaths = new Map();
    for (const [name, config] of Object.entries(initialStores)) {
        const keyPath = config.keyPath;
        const store = new Map();
        for (const record of config.records || []) store.set(record[keyPath], clone(record));
        stores.set(name, store);
        keyPaths.set(name, keyPath);
    }

    const pendingCompletions = [];
    const state = {
        openCalls: 0,
        upgrades: 0,
        name: null,
        version: null,
        createdStores: [],
        holdCompletions: false,
        nextRequestFailure: null,
        failTransactionStart: false,
    };
    let databaseVersion = version;

    function createTransaction(names, mode) {
        if (state.failTransactionStart) {
            state.failTransactionStart = false;
            throw new Error('transaction start failed');
        }
        const storeNames = Array.isArray(names) ? names.slice() : [names];
        for (const name of storeNames) {
            if (!stores.has(name)) throw new Error(`missing store: ${name}`);
        }
        const working = new Map(storeNames.map((name) => [name, cloneStore(stores.get(name))]));
        let pending = 0;
        let completionQueued = false;
        let aborted = false;
        let completed = false;

        const transaction = {
            error: null,
            objectStore(name) {
                if (!working.has(name)) throw new Error(`store not in transaction: ${name}`);
                const store = working.get(name);
                const keyPath = keyPaths.get(name);
                const request = (operationName, operation) => {
                    const result = { result: undefined, error: null };
                    pending += 1;
                    queueMicrotask(() => {
                        if (aborted) return;
                        const failure = state.nextRequestFailure;
                        if (failure && failure.store === name
                                && failure.operation === operationName) {
                            state.nextRequestFailure = null;
                            const error = new Error(`${name}.${operationName} failed`);
                            result.error = error;
                            transaction.error = error;
                            if (failure.kind !== 'abort') {
                                result.onerror?.();
                                transaction.onerror?.();
                            }
                            abort(error);
                            return;
                        }
                        try {
                            result.result = operation();
                            result.onsuccess?.();
                            pending -= 1;
                            queueCompletion();
                        } catch (error) {
                            result.error = error;
                            transaction.error = error;
                            result.onerror?.();
                            transaction.onerror?.();
                            abort(error);
                        }
                    });
                    return result;
                };
                return {
                    get: (key) => request('get', () => clone(store.get(key))),
                    getAll: () => request(
                        'getAll',
                        () => Array.from(store.values(), clone),
                    ),
                    clear: () => request('clear', () => store.clear()),
                    put: (record) => request('put', () => {
                        const key = record[keyPath];
                        if (key === undefined) throw new Error(`missing key path: ${keyPath}`);
                        store.set(key, clone(record));
                        return key;
                    }),
                };
            },
            abort() {
                abort(new Error('transaction aborted'));
            },
            onerror: null,
            onabort: null,
            oncomplete: null,
        };

        function abort(error) {
            if (aborted || completed) return;
            aborted = true;
            transaction.error = error;
            queueMicrotask(() => transaction.onabort?.());
        }

        function queueCompletion() {
            if (completionQueued || pending || aborted || completed) return;
            completionQueued = true;
            queueMicrotask(() => {
                completionQueued = false;
                if (pending || aborted || completed) return;
                const complete = () => {
                    if (aborted || completed) return;
                    if (mode === 'readwrite') {
                        for (const name of storeNames) {
                            stores.set(name, cloneStore(working.get(name)));
                        }
                    }
                    completed = true;
                    transaction.oncomplete?.();
                };
                if (state.holdCompletions) pendingCompletions.push(complete);
                else complete();
            });
        }

        queueCompletion();
        return transaction;
    }

    const database = {
        objectStoreNames: { contains: (name) => stores.has(name) },
        createObjectStore(name, options) {
            if (!options || typeof options.keyPath !== 'string') {
                throw new Error('keyPath is required');
            }
            stores.set(name, new Map());
            keyPaths.set(name, options.keyPath);
            state.createdStores.push({ name, keyPath: options.keyPath });
        },
        transaction(names, mode) {
            return createTransaction(names, mode);
        },
        close() {},
        onversionchange: null,
    };

    const indexedDB = {
        open(name, requestedVersion) {
            state.openCalls += 1;
            state.name = name;
            state.version = requestedVersion;
            const request = { result: database, error: null, transaction: { abort() {} } };
            queueMicrotask(() => {
                if (blocked) {
                    request.onblocked?.();
                    return;
                }
                if (openError) {
                    request.error = new Error('open failed');
                    request.onerror?.();
                    return;
                }
                if (databaseVersion < requestedVersion) {
                    state.upgrades += 1;
                    request.onupgradeneeded?.({
                        oldVersion: databaseVersion,
                        newVersion: requestedVersion,
                    });
                    databaseVersion = requestedVersion;
                }
                request.onsuccess?.();
            });
            return request;
        },
    };

    return {
        indexedDB,
        state,
        failNextRequest(store, operation, kind = 'error') {
            state.nextRequestFailure = { store, operation, kind };
        },
        failNextTransactionStart() {
            state.failTransactionStart = true;
        },
        rawSet(storeName, key, record) {
            stores.get(storeName).set(key, clone(record));
        },
        rawGetAll(storeName) {
            return Array.from(stores.get(storeName).values(), clone);
        },
        releaseCompletions() {
            state.holdCompletions = false;
            pendingCompletions.splice(0).forEach((complete) => complete());
        },
    };
}

function song(id = SONG_A, title = 'Alpha', artist = 'Artist A', extra = {}) {
    return { id, title, artist, ...extra };
}

function serverSnapshot(songs = [song()], overrides = {}) {
    return {
        schema: SCHEMA,
        source: 'local',
        revision: REVISION,
        count: songs.length,
        total: songs.length,
        songs,
        ...overrides,
    };
}

function metadata(overrides = {}) {
    return {
        key: 'current',
        schema: SCHEMA,
        source: 'local',
        revision: REVISION,
        capturedAt: 123,
        count: 1,
        total: 1,
        complete: true,
        ...overrides,
    };
}

async function tick() {
    await new Promise((resolve) => setImmediate(resolve));
}

test('catalog opens lazily, coalesces version-2 open, and creates both stores', async () => {
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
    assert.equal(fake.state.version, 2);
    assert.deepEqual(fake.state.createdStores, [
        { name: 'songs', keyPath: 'id' },
        { name: 'snapshots', keyPath: 'key' },
    ]);
    assert.equal(fake.state.openCalls, 1);
});

test('version-1 song residue has no complete snapshot marker and reads as null', async () => {
    const module = await loadModule();
    const fake = createFakeIndexedDB({
        version: 1,
        initialStores: {
            songs: { keyPath: 'id', records: [song()] },
        },
    });
    const catalog = module.createDeviceCatalog({ indexedDB: fake.indexedDB });

    assert.equal(await catalog.readSnapshot(), null);
    assert.deepEqual(fake.state.createdStores, [{ name: 'snapshots', keyPath: 'key' }]);
    assert.equal(fake.rawGetAll('songs').length, 1);
});

test('replacement and read are detached, id-sorted, and strip extra fields', async () => {
    const module = await loadModule();
    const fake = createFakeIndexedDB();
    const catalog = module.createDeviceCatalog({ indexedDB: fake.indexedDB });
    const input = serverSnapshot([
        song(SONG_B, 'Beta', 'Artist B', { artwork: '/private/art.jpg' }),
        song(SONG_A, 'Alpha', 'Artist A', { filename: '/private/song.archive' }),
    ], { futureEnvelopeField: 'ignored' });

    const replaced = await catalog.replaceSnapshot(input, { capturedAt: 456 });
    input.songs[0].title = 'caller mutation';
    replaced.metadata.revision = '0'.repeat(64);
    replaced.songs[0].artist = 'result mutation';

    const expectedSongs = [song(SONG_A), song(SONG_B, 'Beta', 'Artist B')];
    const read = await catalog.readSnapshot();
    assert.deepEqual(read, {
        metadata: metadata({ capturedAt: 456, count: 2, total: 2 }),
        songs: expectedSongs,
    });
    assert.deepEqual(fake.rawGetAll('songs'), expectedSongs);
    assert.equal('artwork' in read.songs[1], false);
    assert.equal('filename' in read.songs[0], false);
    assert.equal('futureEnvelopeField' in read.metadata, false);

    read.songs[0].title = 'read mutation';
    assert.deepEqual((await catalog.readSnapshot()).songs, expectedSongs);
});

test('metadata uses supplied or current browser capture time', async () => {
    const module = await loadModule();
    const suppliedFake = createFakeIndexedDB();
    const supplied = module.createDeviceCatalog({ indexedDB: suppliedFake.indexedDB });
    assert.equal(
        (await supplied.replaceSnapshot(serverSnapshot(), { capturedAt: 789 }))
            .metadata.capturedAt,
        789,
    );

    const currentFake = createFakeIndexedDB();
    const current = module.createDeviceCatalog({
        indexedDB: currentFake.indexedDB,
        now: () => 987,
    });
    assert.equal(
        (await current.replaceSnapshot(serverSnapshot())).metadata.capturedAt,
        987,
    );
});

test('a complete zero-song snapshot replaces previous rows', async () => {
    const module = await loadModule();
    const fake = createFakeIndexedDB();
    const catalog = module.createDeviceCatalog({ indexedDB: fake.indexedDB });
    await catalog.replaceSnapshot(serverSnapshot(), { capturedAt: 1 });

    const empty = await catalog.replaceSnapshot(serverSnapshot([], {
        revision: '0'.repeat(64),
    }), { capturedAt: 2 });

    assert.deepEqual(empty, {
        metadata: metadata({
            revision: '0'.repeat(64),
            capturedAt: 2,
            count: 0,
            total: 0,
        }),
        songs: [],
    });
    assert.deepEqual(await catalog.readSnapshot(), empty);
});

test('malformed replacements reject before opening or mutating IndexedDB', async () => {
    const module = await loadModule();
    const fake = createFakeIndexedDB();
    const catalog = module.createDeviceCatalog({ indexedDB: fake.indexedDB });
    const inherited = Object.assign(Object.create({ schema: SCHEMA }), {
        source: 'local', revision: REVISION, count: 0, total: 0, songs: [],
    });
    const cases = [
        null,
        inherited,
        serverSnapshot([], { schema: 'wrong' }),
        serverSnapshot([], { source: 'remote' }),
        serverSnapshot([], { revision: REVISION.toUpperCase() }),
        serverSnapshot([], { revision: 'a'.repeat(63) }),
        serverSnapshot([], { count: -1 }),
        serverSnapshot([], { count: 0.5 }),
        serverSnapshot([], { count: Number.MAX_SAFE_INTEGER + 1 }),
        serverSnapshot([], { total: 1 }),
        serverSnapshot([], { songs: 'not-an-array' }),
        serverSnapshot([Object.assign(Object.create({ id: SONG_A }), {
            title: 'Alpha', artist: 'Artist A',
        })]),
        serverSnapshot([song('not-a-hash')]),
        serverSnapshot([song(SONG_A, 'x'.repeat(513))]),
        serverSnapshot([song(SONG_A, 'Alpha', 'x'.repeat(513))]),
        serverSnapshot([song(SONG_A), song(SONG_A)], { count: 2, total: 2 }),
        serverSnapshot([], { capturedAt: 1 }),
        serverSnapshot([], { complete: false }),
    ];

    for (const invalid of cases) {
        assert.throws(() => catalog.replaceSnapshot(invalid, { capturedAt: 1 }), TypeError);
    }
    assert.throws(
        () => catalog.replaceSnapshot(serverSnapshot(), { capturedAt: -1 }),
        TypeError,
    );
    assert.throws(
        () => catalog.replaceSnapshot(serverSnapshot(), { capturedAt: 1.5 }),
        TypeError,
    );
    assert.equal(fake.state.openCalls, 0);

    const valid = await catalog.replaceSnapshot(serverSnapshot(), { capturedAt: 1 });
    assert.deepEqual(await catalog.readSnapshot(), valid);
});

test('Unicode text bounds count characters rather than UTF-16 code units', async () => {
    const module = await loadModule();
    const fake = createFakeIndexedDB();
    const catalog = module.createDeviceCatalog({ indexedDB: fake.indexedDB });
    const accepted = serverSnapshot([song(SONG_A, '🎸'.repeat(512))]);

    await catalog.replaceSnapshot(accepted, { capturedAt: 1 });
    assert.throws(
        () => catalog.replaceSnapshot(
            serverSnapshot([song(SONG_A, '🎸'.repeat(513))]),
            { capturedAt: 2 },
        ),
        TypeError,
    );
});

test('missing, incomplete, corrupt, and mismatched persisted snapshots fail explicitly', async (t) => {
    const module = await loadModule();
    const cases = [
        ['incomplete marker', metadata({ complete: false }), [song()]],
        ['bad schema', metadata({ schema: 'wrong' }), [song()]],
        ['bad source', metadata({ source: 'remote' }), [song()]],
        ['bad revision', metadata({ revision: 'A'.repeat(64) }), [song()]],
        ['bad capturedAt', metadata({ capturedAt: -1 }), [song()]],
        ['count mismatch', metadata({ count: 2, total: 2 }), [song()]],
        ['malformed song', metadata(), [{ id: SONG_A, title: 1, artist: 'Artist' }]],
    ];

    for (const [name, marker, songs] of cases) {
        await t.test(name, async () => {
            const fake = createFakeIndexedDB({
                version: 2,
                initialStores: {
                    songs: { keyPath: 'id', records: songs },
                    snapshots: { keyPath: 'key', records: [marker] },
                },
            });
            const catalog = module.createDeviceCatalog({ indexedDB: fake.indexedDB });
            await assert.rejects(catalog.readSnapshot(), module.CatalogUnavailableError);
        });
    }

    await t.test('duplicate persisted ids', async () => {
        const fake = createFakeIndexedDB({
            version: 2,
            initialStores: {
                songs: { keyPath: 'id', records: [song()] },
                snapshots: {
                    keyPath: 'key',
                    records: [metadata({ count: 2, total: 2 })],
                },
            },
        });
        fake.rawSet('songs', 'different-storage-key', song());
        const catalog = module.createDeviceCatalog({ indexedDB: fake.indexedDB });
        await assert.rejects(catalog.readSnapshot(), module.CatalogUnavailableError);
    });
});

test('clear, song-write, and marker failures retain the previous complete generation', async (t) => {
    const module = await loadModule();
    const failures = [
        ['clear abort', 'songs', 'clear', 'abort'],
        ['song write error', 'songs', 'put', 'error'],
        ['metadata publication error', 'snapshots', 'put', 'error'],
    ];

    for (const [name, store, operation, kind] of failures) {
        await t.test(name, async () => {
            const fake = createFakeIndexedDB();
            const catalog = module.createDeviceCatalog({ indexedDB: fake.indexedDB });
            const previous = await catalog.replaceSnapshot(
                serverSnapshot(),
                { capturedAt: 1 },
            );
            fake.failNextRequest(store, operation, kind);

            await assert.rejects(
                catalog.replaceSnapshot(
                    serverSnapshot([song(SONG_B, 'Beta', 'Artist B')], {
                        revision: 'e'.repeat(64),
                    }),
                    { capturedAt: 2 },
                ),
                module.CatalogUnavailableError,
            );
            assert.deepEqual(await catalog.readSnapshot(), previous);
        });
    }
});

test('replace and read promises settle only after multi-store transaction completion', async () => {
    const module = await loadModule();
    const fake = createFakeIndexedDB();
    const catalog = module.createDeviceCatalog({ indexedDB: fake.indexedDB });
    fake.state.holdCompletions = true;
    let replaceSettled = false;
    const replacing = catalog.replaceSnapshot(serverSnapshot(), { capturedAt: 1 })
        .finally(() => { replaceSettled = true; });
    await tick();
    assert.equal(replaceSettled, false);
    assert.deepEqual(fake.rawGetAll('songs'), []);
    fake.releaseCompletions();
    await replacing;

    fake.state.holdCompletions = true;
    let readSettled = false;
    const reading = catalog.readSnapshot().finally(() => { readSettled = true; });
    await tick();
    assert.equal(readSettled, false);
    fake.releaseCompletions();
    await reading;
});

test('missing stores and transaction/request failures are catalog-unavailable errors', async () => {
    const module = await loadModule();
    const missingStoreFake = createFakeIndexedDB({
        version: 2,
        initialStores: { songs: { keyPath: 'id', records: [] } },
    });
    await assert.rejects(
        module.createDeviceCatalog({ indexedDB: missingStoreFake.indexedDB }).readSnapshot(),
        module.CatalogUnavailableError,
    );

    const startFake = createFakeIndexedDB();
    const startCatalog = module.createDeviceCatalog({ indexedDB: startFake.indexedDB });
    await startCatalog.open();
    startFake.failNextTransactionStart();
    await assert.rejects(startCatalog.readSnapshot(), module.CatalogUnavailableError);

    const requestFake = createFakeIndexedDB();
    const requestCatalog = module.createDeviceCatalog({ indexedDB: requestFake.indexedDB });
    await requestCatalog.open();
    requestFake.failNextRequest('snapshots', 'get');
    await assert.rejects(requestCatalog.readSnapshot(), module.CatalogUnavailableError);
});

test('missing, blocked, or failed IndexedDB is explicit and old row APIs are removed', async () => {
    const module = await loadModule();
    const missing = module.createDeviceCatalog({ indexedDB: null });
    await assert.rejects(missing.readSnapshot(), module.CatalogUnavailableError);

    const blocked = createFakeIndexedDB({ blocked: true });
    await assert.rejects(
        module.createDeviceCatalog({ indexedDB: blocked.indexedDB }).open(),
        module.CatalogUnavailableError,
    );

    const failed = createFakeIndexedDB({ openError: true });
    await assert.rejects(
        module.createDeviceCatalog({ indexedDB: failed.indexedDB }).readSnapshot(),
        module.CatalogUnavailableError,
    );

    assert.equal(module.listDeviceSongs, undefined);
    assert.equal(module.countDeviceSongs, undefined);
    assert.equal(module.putDeviceSong, undefined);
    assert.equal(module.removeDeviceSong, undefined);
    assert.equal(module.clearDeviceSongs, undefined);
});
