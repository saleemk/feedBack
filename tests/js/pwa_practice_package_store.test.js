'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.join(
    __dirname, '..', '..', 'static', 'js', 'practice-package-store.js',
);
const METADATA_STORE = 'packages';
let importSerial = 0;

async function loadModule() {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    const encoded = Buffer.from(source).toString('base64');
    importSerial += 1;
    return import(`data:text/javascript;base64,${encoded}#${importSerial}`);
}

function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
}

function cloneStore(store) {
    return new Map(Array.from(store, ([key, value]) => [key, clone(value)]));
}

function createFakeIndexedDB({
    openError = false,
    blocked = false,
    version = 0,
    initialStores = {},
    log = [],
} = {}) {
    const stores = new Map();
    const keyPaths = new Map();
    for (const [name, config] of Object.entries(initialStores)) {
        const records = new Map();
        for (const record of config.records || []) {
            records.set(record[config.keyPath], clone(record));
        }
        stores.set(name, records);
        keyPaths.set(name, config.keyPath);
    }
    const state = {
        openCalls: 0,
        upgrades: 0,
        name: null,
        version: null,
        createdStores: [],
        transactions: [],
        closeCalls: 0,
        nextRequestFailure: null,
        putRecords: [],
    };
    let databaseVersion = version;

    function createTransaction(names, mode) {
        const storeNames = Array.isArray(names) ? names.slice() : [names];
        for (const name of storeNames) {
            if (!stores.has(name)) throw new Error(`missing store: ${name}`);
        }
        const transactionLog = { stores: storeNames, mode, operations: [] };
        state.transactions.push(transactionLog);
        const working = new Map(
            storeNames.map((name) => [name, cloneStore(stores.get(name))]),
        );
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
                    transactionLog.operations.push({ store: name, operation: operationName });
                    pending += 1;
                    queueMicrotask(() => {
                        if (aborted) return;
                        const failure = state.nextRequestFailure;
                        if (failure?.store === name && failure.operation === operationName) {
                            state.nextRequestFailure = null;
                            const requestError = failure.error
                                || new Error(`${name}.${operationName} failed`);
                            const transactionError = failure.transactionError || requestError;
                            result.error = requestError;
                            transaction.error = transactionError;
                            transaction.onerror?.({ target: result, currentTarget: transaction });
                            abort(transactionError);
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
                            transaction.onerror?.({ target: result, currentTarget: transaction });
                            abort(error);
                        }
                    });
                    return result;
                };
                return {
                    get: (key) => request('get', () => clone(store.get(key))),
                    getAll: () => request('getAll', () => Array.from(store.values(), clone)),
                    put: (record) => request('put', () => {
                        const key = record[keyPath];
                        if (key === undefined) throw new Error(`missing key path: ${keyPath}`);
                        const stored = clone(record);
                        state.putRecords.push(stored);
                        log.push(`idb:put:${name}`);
                        store.set(key, stored);
                        return key;
                    }),
                    delete: (key) => request('delete', () => {
                        log.push(`idb:delete:${name}`);
                        return store.delete(key);
                    }),
                };
            },
            abort() { abort(new Error('transaction aborted')); },
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
                if (mode === 'readwrite') {
                    for (const name of storeNames) {
                        stores.set(name, cloneStore(working.get(name)));
                    }
                }
                completed = true;
                transaction.oncomplete?.();
            });
        }

        queueCompletion();
        return transaction;
    }

    const database = {
        objectStoreNames: { contains: (name) => stores.has(name) },
        createObjectStore(name, { keyPath }) {
            stores.set(name, new Map());
            keyPaths.set(name, keyPath);
            state.createdStores.push({ name, keyPath });
        },
        transaction: createTransaction,
        close() { state.closeCalls += 1; },
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
                    request.onupgradeneeded?.();
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
        database,
        failNextRequest(store, operation, error = null, transactionError = null) {
            state.nextRequestFailure = { store, operation, error, transactionError };
        },
        rawGetAll(store) { return Array.from(stores.get(store).values(), clone); },
        rawSet(store, key, value) { stores.get(store).set(key, clone(value)); },
    };
}

class FakeFile {
    constructor(name, bytes, type = '') {
        this.name = name;
        this.type = type;
        this.size = bytes.byteLength;
        this.lastModified = 1;
        this._bytes = bytes.slice();
    }

    async arrayBuffer() {
        return this._bytes.slice().buffer;
    }

    async text() {
        return new TextDecoder().decode(this._bytes);
    }
}

function notFound(message) {
    return new DOMException(message, 'NotFoundError');
}

function concatChunks(chunks) {
    const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

function createFakeOpfs({ log = [] } = {}) {
    const root = { kind: 'directory', name: '', directories: new Map(), files: new Map() };
    const state = { calls: [], writes: [], removals: [], failure: null, arrayBuffers: [] };

    function pathFor(parentPath, name) {
        return parentPath ? `${parentPath}/${name}` : name;
    }

    function shouldFail(stage, targetPath) {
        if (state.failure?.stage !== stage) return null;
        if (state.failure.path && state.failure.path !== targetPath) return null;
        const error = state.failure.error || new DOMException(`${stage} failed`, 'UnknownError');
        state.failure = null;
        return error;
    }

    function directoryHandle(node, directoryPath = '') {
        return {
            kind: 'directory',
            name: node.name,
            async getDirectoryHandle(name, { create = false } = {}) {
                const childPath = pathFor(directoryPath, name);
                state.calls.push(`directory:${childPath}:${create}`);
                let child = node.directories.get(name);
                if (!child && create) {
                    child = { kind: 'directory', name, directories: new Map(), files: new Map() };
                    node.directories.set(name, child);
                }
                if (!child) throw notFound(`Missing directory: ${childPath}`);
                return directoryHandle(child, childPath);
            },
            async getFileHandle(name, { create = false } = {}) {
                const filePath = pathFor(directoryPath, name);
                state.calls.push(`file:${filePath}:${create}`);
                let file = node.files.get(name);
                if (!file && create) {
                    file = { name, bytes: new Uint8Array() };
                    node.files.set(name, file);
                }
                if (!file) throw notFound(`Missing file: ${filePath}`);
                return {
                    kind: 'file',
                    name,
                    async createWritable() {
                        const failure = shouldFail('createWritable', filePath);
                        if (failure) throw failure;
                        const chunks = [];
                        return new WritableStream({
                            write(chunk) {
                                const writeFailure = shouldFail('write', filePath);
                                if (writeFailure) throw writeFailure;
                                const bytes = chunk instanceof Uint8Array
                                    ? chunk.slice()
                                    : new Uint8Array(chunk);
                                chunks.push(bytes);
                                state.writes.push({ path: filePath, bytes: bytes.byteLength });
                                log.push(`opfs:write:${filePath}`);
                            },
                            close() {
                                const closeFailure = shouldFail('close', filePath);
                                if (closeFailure) throw closeFailure;
                                file.bytes = concatChunks(chunks);
                                log.push(`opfs:close:${filePath}`);
                            },
                        });
                    },
                    async getFile() {
                        const failure = shouldFail('getFile', filePath);
                        if (failure) throw failure;
                        const type = name.endsWith('.ogg') ? 'audio/ogg' : 'application/x-ndjson';
                        const result = new FakeFile(name, file.bytes, type);
                        const original = result.arrayBuffer.bind(result);
                        result.arrayBuffer = async () => {
                            state.arrayBuffers.push(filePath);
                            return original();
                        };
                        return result;
                    },
                };
            },
            async removeEntry(name, { recursive = false } = {}) {
                const targetPath = pathFor(directoryPath, name);
                const failure = shouldFail('remove', targetPath);
                if (failure) throw failure;
                if (!node.directories.has(name) && !node.files.has(name)) {
                    throw notFound(`Missing entry: ${targetPath}`);
                }
                node.directories.delete(name);
                node.files.delete(name);
                state.removals.push({ path: targetPath, recursive });
                log.push(`opfs:remove:${targetPath}`);
            },
        };
    }

    function directoryNode(pathParts) {
        let node = root;
        for (const part of pathParts) {
            node = node.directories.get(part);
            if (!node) return null;
        }
        return node;
    }

    return {
        root: directoryHandle(root),
        state,
        failNext(stage, targetPath = '', error = null) {
            state.failure = { stage, path: targetPath, error };
        },
        hasRevision(revision) {
            return Boolean(directoryNode(['practice-packages', revision]));
        },
        removeFile(revision, name) {
            directoryNode(['practice-packages', revision])?.files.delete(name);
        },
        replaceFile(revision, name, bytes) {
            const directory = directoryNode(['practice-packages', revision]);
            directory.files.set(name, { name, bytes: Uint8Array.from(bytes) });
        },
        fileBytes(revision, name) {
            return directoryNode(['practice-packages', revision])?.files.get(name)?.bytes;
        },
        hasFile(relativePath) {
            const parts = relativePath.split('/');
            const name = parts.pop();
            return Boolean(directoryNode(parts)?.files.has(name));
        },
        fileBytesAt(relativePath) {
            const parts = relativePath.split('/');
            const name = parts.pop();
            return directoryNode(parts)?.files.get(name)?.bytes;
        },
        removeFileAt(relativePath) {
            const parts = relativePath.split('/');
            const name = parts.pop();
            directoryNode(parts)?.files.delete(name);
        },
        replaceFileAt(relativePath, bytes) {
            const parts = relativePath.split('/');
            const name = parts.pop();
            let node = root;
            for (const part of parts) {
                let child = node.directories.get(part);
                if (!child) {
                    child = { kind: 'directory', name: part, directories: new Map(), files: new Map() };
                    node.directories.set(part, child);
                }
                node = child;
            }
            node.files.set(name, { name, bytes: Uint8Array.from(bytes) });
        },
    };
}

function createFakeLockManager() {
    let tail = Promise.resolve();
    const state = { requests: [], entries: 0, exits: 0 };
    return {
        state,
        request(name, options, callback) {
            state.requests.push({ name, options: clone(options) });
            const previous = tail;
            let release;
            tail = new Promise((resolve) => { release = resolve; });
            return previous.then(async () => {
                state.entries += 1;
                try {
                    return await callback({ name, mode: options.mode });
                } finally {
                    state.exits += 1;
                    release();
                }
            });
        },
    };
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function trackedStream(bytes, chunkSize = 5) {
    const source = Uint8Array.from(bytes);
    const tracker = { cancelCalls: 0 };
    let offset = 0;
    const stream = new ReadableStream({
        pull(controller) {
            if (offset >= source.byteLength) {
                controller.close();
                return;
            }
            const end = Math.min(offset + chunkSize, source.byteLength);
            controller.enqueue(source.slice(offset, end));
            offset = end;
        },
        cancel() {
            tracker.cancelCalls += 1;
        },
    });
    return { stream, tracker };
}

function streamBytes(bytes, chunkSize = 5) {
    return trackedStream(bytes, chunkSize).stream;
}

function fixture({
    chartBytes = Buffer.from('{"type":"song_info"}\n{"type":"ready"}\n'),
    audioBytes = Buffer.from('small fake full mix streamed in chunks'),
    arrangementIndex = 2,
    arrangementName = 'Lead',
} = {}) {
    const chartSha = sha256(chartBytes);
    const audioSha = sha256(audioBytes);
    const revision = sha256(Buffer.concat([
        Buffer.from(chartSha, 'hex'),
        Buffer.from(audioSha, 'hex'),
    ]));
    const manifest = {
        schema: 'feedback.practice-package.manifest.v1',
        revision,
        source: { filename: 'Artist/Song & Mix.sloppak' },
        song: { title: 'Song', artist: 'Artist', duration: 123.5 },
        arrangement: {
            index: arrangementIndex,
            name: arrangementName,
            smart_name: `${arrangementName} Guitar`,
            naming_mode: 'smart',
            drum_part: null,
        },
        chart: {
            url: '/api/practice-package/chart?filename=encoded',
            media_type: 'application/x-ndjson',
            bytes: chartBytes.length,
            sha256: chartSha,
        },
        audio: {
            url: '/api/sloppak/song/file/full.ogg',
            bytes: audioBytes.length,
            sha256: audioSha,
        },
    };
    return {
        revision,
        manifest,
        chartBytes,
        audioBytes,
        artifacts({ chart = chartBytes, audio = audioBytes } = {}) {
            return {
                chart: {
                    stream: streamBytes(chart),
                    mediaType: 'application/x-ndjson; charset=utf-8',
                },
                audio: { stream: streamBytes(audio), mediaType: 'audio/ogg' },
            };
        },
    };
}

function secondArrangement(audioBytes) {
    return fixture({
        chartBytes: Buffer.from('{"type":"song_info","arrangement":"Rhythm"}\n{"type":"ready"}\n'),
        audioBytes,
        arrangementIndex: 3,
        arrangementName: 'Rhythm',
    });
}

function sharedAudioPath(input) {
    return `practice-packages/audio/${input.manifest.audio.sha256}.ogg`;
}

async function createStore(fakeIdb, fakeOpfs, options = {}) {
    const module = await loadModule();
    return {
        module,
        store: module.createPracticePackageStore({
            indexedDB: fakeIdb.indexedDB,
            getOpfsRoot: async () => fakeOpfs.root,
            crypto: webcrypto,
            FileClass: FakeFile,
            now: () => 123,
            requestLock: null,
            ...options,
        }),
    };
}

function containsBinary(value) {
    if (!value || typeof value !== 'object') return false;
    if (value instanceof Blob || value instanceof FakeFile
            || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
    return Object.values(value).some(containsBinary);
}

test('opens independent metadata and OPFS storage with one lightweight store', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const { store } = await createStore(fakeIdb, fakeOpfs);

    await store.open();

    assert.equal(fakeIdb.state.name, 'feedback-practice-packages');
    assert.equal(fakeIdb.state.version, 1);
    assert.deepEqual(fakeIdb.state.createdStores, [
        { name: METADATA_STORE, keyPath: 'revision' },
    ]);
});

test('unavailable IndexedDB or OPFS and blocked/open failures are explicit', async () => {
    const module = await loadModule();
    const fakeOpfs = createFakeOpfs();
    await assert.rejects(
        module.createPracticePackageStore({
            indexedDB: null,
            getOpfsRoot: async () => fakeOpfs.root,
        }).open(),
        module.PracticePackageStoreError,
    );
    for (const options of [{ blocked: true }, { openError: true }]) {
        const fakeIdb = createFakeIndexedDB(options);
        await assert.rejects(
            module.createPracticePackageStore({
                indexedDB: fakeIdb.indexedDB,
                getOpfsRoot: async () => fakeOpfs.root,
            }).open(),
            module.PracticePackageStoreError,
        );
    }
    const fakeIdb = createFakeIndexedDB();
    await assert.rejects(
        module.createPracticePackageStore({
            indexedDB: fakeIdb.indexedDB,
            getOpfsRoot: async () => null,
        }).open(),
        module.PracticePackageStoreError,
    );
});

test('streams fixed OPFS files before publishing binary-free metadata', async () => {
    const log = [];
    const fakeIdb = createFakeIndexedDB({ log });
    const fakeOpfs = createFakeOpfs({ log });
    const { store } = await createStore(fakeIdb, fakeOpfs);
    const input = fixture();

    const metadata = await store.saveCompletePackage(input.manifest, input.artifacts());

    const prefix = `practice-packages/${input.revision}`;
    assert.deepEqual(
        fakeOpfs.fileBytes(input.revision, 'chart.ndjson'),
        Uint8Array.from(input.chartBytes),
    );
    assert.deepEqual(
        fakeOpfs.fileBytes(input.revision, 'audio.ogg'),
        Uint8Array.from(input.audioBytes),
    );
    assert.ok(fakeOpfs.state.writes.filter((entry) => entry.path === `${prefix}/audio.ogg`).length > 1);
    assert.ok(log.indexOf(`opfs:close:${prefix}/chart.ndjson`) < log.indexOf('idb:put:packages'));
    assert.ok(log.indexOf(`opfs:close:${prefix}/audio.ogg`) < log.indexOf('idb:put:packages'));
    assert.equal(metadata.complete, true);
    assert.equal(metadata.audio.integrityVerified, false);
    assert.equal(fakeIdb.state.putRecords.some(containsBinary), false);
    assert.equal(fakeOpfs.state.arrayBuffers.includes(`${prefix}/audio.ogg`), false);
});

test('write, verification, and metadata failures clean the unpublished revision', async (t) => {
    const cases = [
        ['chart write', (input, opfs) => {
            opfs.failNext('write', `practice-packages/${input.revision}/chart.ndjson`);
            return input.artifacts();
        }],
        ['audio write', (input, opfs) => {
            opfs.failNext('write', `practice-packages/${input.revision}/audio.ogg`);
            return input.artifacts();
        }],
        ['chart verification', (input) => {
            const changed = Buffer.alloc(input.chartBytes.length, 120);
            return input.artifacts({ chart: changed });
        }],
        ['audio size verification', (input) => input.artifacts({ audio: Buffer.from('short') })],
    ];
    for (const [name, arrange] of cases) {
        await t.test(name, async () => {
            const fakeIdb = createFakeIndexedDB();
            const fakeOpfs = createFakeOpfs();
            const { store } = await createStore(fakeIdb, fakeOpfs);
            const input = fixture();
            const artifacts = arrange(input, fakeOpfs);

            await assert.rejects(store.saveCompletePackage(input.manifest, artifacts));

            assert.equal(fakeOpfs.hasRevision(input.revision), false);
            assert.deepEqual(fakeIdb.rawGetAll(METADATA_STORE), []);
        });
    }

    await t.test('metadata publication with request cause', async () => {
        const fakeIdb = createFakeIndexedDB();
        const fakeOpfs = createFakeOpfs();
        const { module, store } = await createStore(fakeIdb, fakeOpfs);
        const input = fixture();
        const requestError = new DOMException('Metadata rejected', 'UnknownError');
        const transactionError = new DOMException('Transaction aborted', 'AbortError');
        fakeIdb.failNextRequest(
            METADATA_STORE,
            'put',
            requestError,
            transactionError,
        );

        await assert.rejects(
            store.saveCompletePackage(input.manifest, input.artifacts()),
            (error) => {
                assert.equal(error instanceof module.PracticePackageStoreError, true);
                assert.equal(error.cause, requestError);
                return true;
            },
        );
        assert.equal(fakeOpfs.hasRevision(input.revision), false);
        assert.deepEqual(fakeIdb.rawGetAll(METADATA_STORE), []);
    });
});

test('an early chart write failure cancels the untouched audio stream', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const { store } = await createStore(fakeIdb, fakeOpfs);
    const input = fixture();
    const chart = trackedStream(input.chartBytes);
    const audio = trackedStream(input.audioBytes);
    fakeOpfs.failNext('write', `practice-packages/${input.revision}/chart.ndjson`);

    await assert.rejects(store.saveCompletePackage(input.manifest, {
        chart: { stream: chart.stream, mediaType: 'application/x-ndjson' },
        audio: { stream: audio.stream, mediaType: 'audio/ogg' },
    }));

    assert.equal(audio.tracker.cancelCalls, 1);
});

test('descriptor validation releases every valid supplied stream', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const { store } = await createStore(fakeIdb, fakeOpfs);
    const input = fixture();
    const chart = trackedStream(input.chartBytes);
    const audio = trackedStream(input.audioBytes);

    await assert.rejects(store.saveCompletePackage(input.manifest, {
        chart: { stream: chart.stream, mediaType: 'application/x-ndjson' },
        audio: { stream: audio.stream },
    }), TypeError);

    assert.equal(chart.tracker.cancelCalls, 1);
    assert.equal(audio.tracker.cancelCalls, 1);
});

test('listing complete metadata does not access OPFS', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const first = await createStore(fakeIdb, fakeOpfs);
    const input = fixture();
    await first.store.saveCompletePackage(input.manifest, input.artifacts());

    let opfsCalls = 0;
    const second = await createStore(fakeIdb, fakeOpfs, {
        getOpfsRoot: async () => { opfsCalls += 1; return fakeOpfs.root; },
    });
    const packages = await second.store.listPackages();

    assert.equal(packages.length, 1);
    assert.equal(opfsCalls, 0);
    assert.deepEqual(fakeIdb.state.transactions.at(-1).stores, [METADATA_STORE]);
});

test('reopen returns validated OPFS File objects after a fresh store instance', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const first = await createStore(fakeIdb, fakeOpfs);
    const input = fixture();
    await first.store.saveCompletePackage(input.manifest, input.artifacts());
    first.store.close();

    const second = await createStore(fakeIdb, fakeOpfs);
    const stored = await second.store.readPackage(input.revision);

    assert.equal(stored.metadata.revision, input.revision);
    assert.equal(stored.chart instanceof FakeFile, true);
    assert.equal(stored.audio instanceof FakeFile, true);
    assert.equal(await stored.chart.text(), input.chartBytes.toString());
    assert.equal(await stored.audio.text(), input.audioBytes.toString());
});

test('missing and wrong-sized OPFS artifacts fail safely', async (t) => {
    await t.test('missing chart', async () => {
        const fakeIdb = createFakeIndexedDB();
        const fakeOpfs = createFakeOpfs();
        const { module, store } = await createStore(fakeIdb, fakeOpfs);
        const input = fixture();
        await store.saveCompletePackage(input.manifest, input.artifacts());
        fakeOpfs.removeFile(input.revision, 'chart.ndjson');
        await assert.rejects(store.readPackage(input.revision), module.PracticePackageStoreError);
    });

    await t.test('wrong audio size', async () => {
        const fakeIdb = createFakeIndexedDB();
        const fakeOpfs = createFakeOpfs();
        const { module, store } = await createStore(fakeIdb, fakeOpfs);
        const input = fixture();
        await store.saveCompletePackage(input.manifest, input.artifacts());
        fakeOpfs.replaceFile(input.revision, 'audio.ogg', [1]);
        await assert.rejects(store.readPackage(input.revision), module.PracticePackageStoreError);
    });
});

test('delete hides metadata before OPFS cleanup and leaves cleanup failures invisible', async () => {
    const log = [];
    const fakeIdb = createFakeIndexedDB({ log });
    const fakeOpfs = createFakeOpfs({ log });
    const { module, store } = await createStore(fakeIdb, fakeOpfs);
    const input = fixture();
    await store.saveCompletePackage(input.manifest, input.artifacts());
    log.length = 0;
    fakeOpfs.failNext('remove', `practice-packages/${input.revision}`);

    await assert.rejects(store.deletePackage(input.revision), module.PracticePackageStoreError);

    assert.equal(log[0], 'idb:delete:packages');
    assert.deepEqual(await store.listPackages(), []);
    assert.equal(fakeOpfs.hasRevision(input.revision), true);

    await store.deletePackage(input.revision);
    assert.equal(fakeOpfs.hasRevision(input.revision), false);
});

test('an existing complete revision is validated and reused without rewriting streams', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const { store } = await createStore(fakeIdb, fakeOpfs);
    const input = fixture();
    const first = await store.saveCompletePackage(input.manifest, input.artifacts());
    const writeCount = fakeOpfs.state.writes.length;
    const chart = trackedStream(input.chartBytes);
    const audio = trackedStream(input.audioBytes);

    const reused = await store.saveCompletePackage(input.manifest, {
        chart: { stream: chart.stream, mediaType: 'application/x-ndjson' },
        audio: { stream: audio.stream, mediaType: 'audio/ogg' },
    });

    assert.deepEqual(reused, first);
    assert.equal(fakeOpfs.state.writes.length, writeCount);
    assert.equal(chart.tracker.cancelCalls, 1);
    assert.equal(audio.tracker.cancelCalls, 1);
});

test('lock-capable saves share one streamed audio file across independent revisions', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const locks = createFakeLockManager();
    const { store } = await createStore(fakeIdb, fakeOpfs, {
        requestLock: locks.request,
    });
    const lead = fixture();
    const rhythm = secondArrangement(lead.audioBytes);
    const reusedAudio = trackedStream(rhythm.audioBytes);

    await store.saveCompletePackage(lead.manifest, lead.artifacts());
    await store.saveCompletePackage(rhythm.manifest, {
        chart: {
            stream: streamBytes(rhythm.chartBytes),
            mediaType: 'application/x-ndjson',
        },
        audio: { stream: reusedAudio.stream, mediaType: 'audio/ogg' },
    });

    const audioPath = sharedAudioPath(lead);
    assert.equal(fakeOpfs.hasFile(audioPath), true);
    assert.equal(fakeOpfs.hasFile(`practice-packages/${lead.revision}/audio.ogg`), false);
    assert.equal(fakeOpfs.hasFile(`practice-packages/${rhythm.revision}/audio.ogg`), false);
    assert.equal(
        fakeOpfs.state.calls.filter((call) => call === `file:${audioPath}:true`).length,
        1,
    );
    assert.equal(reusedAudio.tracker.cancelCalls, 1);

    const storedLead = await store.readPackage(lead.revision);
    const storedRhythm = await store.readPackage(rhythm.revision);
    assert.equal(await storedLead.chart.text(), lead.chartBytes.toString());
    assert.equal(await storedRhythm.chart.text(), rhythm.chartBytes.toString());
    assert.equal(await storedLead.audio.text(), lead.audioBytes.toString());
    assert.equal(await storedRhythm.audio.text(), rhythm.audioBytes.toString());
    assert.deepEqual(fakeOpfs.state.arrayBuffers.filter((path) => path.endsWith('.ogg')), []);
});

test('a Web Lock serializes shared saves from separate store instances', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const locks = createFakeLockManager();
    const first = await createStore(fakeIdb, fakeOpfs, { requestLock: locks.request });
    const second = await createStore(fakeIdb, fakeOpfs, { requestLock: locks.request });
    const lead = fixture();
    const rhythm = secondArrangement(lead.audioBytes);

    await Promise.all([
        first.store.saveCompletePackage(lead.manifest, lead.artifacts()),
        second.store.saveCompletePackage(rhythm.manifest, rhythm.artifacts()),
    ]);

    const audioPath = sharedAudioPath(lead);
    assert.equal(locks.state.entries, 2);
    assert.equal(locks.state.exits, 2);
    assert.deepEqual(
        locks.state.requests.map(({ name, options }) => [name, options.mode]),
        [
            ['feedback-practice-packages:audio:v1', 'exclusive'],
            ['feedback-practice-packages:audio:v1', 'exclusive'],
        ],
    );
    assert.equal(
        fakeOpfs.state.calls.filter((call) => call === `file:${audioPath}:true`).length,
        1,
    );
    assert.equal((await first.store.listPackages()).length, 2);
});

test('save and delete interleaving preserves the newly saved shared reference', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const locks = createFakeLockManager();
    const first = await createStore(fakeIdb, fakeOpfs, { requestLock: locks.request });
    const second = await createStore(fakeIdb, fakeOpfs, { requestLock: locks.request });
    const lead = fixture();
    const rhythm = secondArrangement(lead.audioBytes);
    await first.store.saveCompletePackage(lead.manifest, lead.artifacts());

    const deleting = first.store.deletePackage(lead.revision);
    const saving = second.store.saveCompletePackage(rhythm.manifest, rhythm.artifacts());
    await Promise.all([deleting, saving]);

    assert.equal(await first.store.readPackage(lead.revision), null);
    assert.equal((await second.store.readPackage(rhythm.revision)).metadata.revision, rhythm.revision);
    assert.equal(fakeOpfs.hasFile(sharedAudioPath(lead)), true);
});

test('shared audio is retained until its final metadata reference is deleted', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const locks = createFakeLockManager();
    const { store } = await createStore(fakeIdb, fakeOpfs, {
        requestLock: locks.request,
    });
    const lead = fixture();
    const rhythm = secondArrangement(lead.audioBytes);
    await store.saveCompletePackage(lead.manifest, lead.artifacts());
    await store.saveCompletePackage(rhythm.manifest, rhythm.artifacts());

    await store.deletePackage(lead.revision);
    assert.equal(fakeOpfs.hasFile(sharedAudioPath(lead)), true);
    assert.equal((await store.readPackage(rhythm.revision)).metadata.revision, rhythm.revision);

    await store.deletePackage(rhythm.revision);
    assert.equal(fakeOpfs.hasFile(sharedAudioPath(lead)), false);
});

test('missing locks and pre-callback lock failures use the legacy layout', async (t) => {
    await t.test('Web Locks unavailable', async () => {
        const fakeIdb = createFakeIndexedDB();
        const fakeOpfs = createFakeOpfs();
        const { store } = await createStore(fakeIdb, fakeOpfs, { requestLock: null });
        const input = fixture();

        await store.saveCompletePackage(input.manifest, input.artifacts());

        assert.equal(fakeOpfs.hasFile(`practice-packages/${input.revision}/audio.ogg`), true);
        assert.equal(fakeOpfs.hasFile(sharedAudioPath(input)), false);
    });

    await t.test('lock acquisition fails before callback', async () => {
        const fakeIdb = createFakeIndexedDB();
        const fakeOpfs = createFakeOpfs();
        const { store } = await createStore(fakeIdb, fakeOpfs, {
            requestLock: async () => { throw new DOMException('locks unavailable', 'NotSupportedError'); },
        });
        const input = fixture();

        await store.saveCompletePackage(input.manifest, input.artifacts());

        assert.equal(fakeOpfs.hasFile(`practice-packages/${input.revision}/audio.ogg`), true);
        assert.equal(fakeOpfs.hasFile(sharedAudioPath(input)), false);
    });
});

test('a callback-started shared write failure never retries through legacy storage', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const locks = createFakeLockManager();
    const { store } = await createStore(fakeIdb, fakeOpfs, {
        requestLock: locks.request,
    });
    const input = fixture();
    const audio = trackedStream(input.audioBytes);
    fakeOpfs.failNext('write', sharedAudioPath(input));

    await assert.rejects(store.saveCompletePackage(input.manifest, {
        chart: {
            stream: streamBytes(input.chartBytes),
            mediaType: 'application/x-ndjson',
        },
        audio: { stream: audio.stream, mediaType: 'audio/ogg' },
    }));

    assert.equal(locks.state.entries, 1);
    assert.equal(audio.tracker.cancelCalls, 1);
    assert.equal(fakeOpfs.hasFile(`practice-packages/${input.revision}/audio.ogg`), false);
    assert.equal(fakeOpfs.hasFile(sharedAudioPath(input)), false);
    assert.deepEqual(fakeIdb.rawGetAll(METADATA_STORE), []);
});

test('lock-capable reads and deletes preserve legacy package compatibility', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const legacy = await createStore(fakeIdb, fakeOpfs, { requestLock: null });
    const input = fixture();
    await legacy.store.saveCompletePackage(input.manifest, input.artifacts());

    const locks = createFakeLockManager();
    const current = await createStore(fakeIdb, fakeOpfs, { requestLock: locks.request });
    assert.equal((await current.store.readPackage(input.revision)).metadata.revision, input.revision);

    await current.store.deletePackage(input.revision);
    assert.equal(fakeOpfs.hasRevision(input.revision), false);
    assert.equal(await current.store.readPackage(input.revision), null);
});

test('invalid shared audio falls back to legacy and is not replaced while referenced', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const legacy = await createStore(fakeIdb, fakeOpfs, { requestLock: null });
    const lead = fixture();
    await legacy.store.saveCompletePackage(lead.manifest, lead.artifacts());
    fakeOpfs.replaceFileAt(sharedAudioPath(lead), [1]);

    const locks = createFakeLockManager();
    const current = await createStore(fakeIdb, fakeOpfs, { requestLock: locks.request });
    assert.equal(await (await current.store.readPackage(lead.revision)).audio.text(), lead.audioBytes.toString());

    const rhythm = secondArrangement(lead.audioBytes);
    await assert.rejects(
        current.store.saveCompletePackage(rhythm.manifest, rhythm.artifacts()),
        /referenced shared audio artifact has an invalid byte count/,
    );
    assert.deepEqual(fakeOpfs.fileBytesAt(sharedAudioPath(lead)), Uint8Array.from([1]));
    assert.equal(await current.store.readPackageMetadata(rhythm.revision), null);
});

test('a shared-only package fails safely when its audio file is missing', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const locks = createFakeLockManager();
    const { module, store } = await createStore(fakeIdb, fakeOpfs, {
        requestLock: locks.request,
    });
    const input = fixture();
    await store.saveCompletePackage(input.manifest, input.artifacts());
    fakeOpfs.removeFileAt(sharedAudioPath(input));

    await assert.rejects(
        store.readPackage(input.revision),
        module.PracticePackageStoreError,
    );
    assert.equal((await store.listPackages()).length, 1);
});

test('an unreferenced wrong-sized shared file is replaced by a streamed save', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const locks = createFakeLockManager();
    const { store } = await createStore(fakeIdb, fakeOpfs, { requestLock: locks.request });
    const input = fixture();
    fakeOpfs.replaceFileAt(sharedAudioPath(input), [1]);

    await store.saveCompletePackage(input.manifest, input.artifacts());

    assert.deepEqual(
        fakeOpfs.fileBytesAt(sharedAudioPath(input)),
        Uint8Array.from(input.audioBytes),
    );
    assert.deepEqual(fakeOpfs.state.arrayBuffers.filter((path) => path.endsWith('.ogg')), []);
});

test('shared publication rollback removes new audio and preserves existing owners', async (t) => {
    await t.test('first metadata publication fails', async () => {
        const fakeIdb = createFakeIndexedDB();
        const fakeOpfs = createFakeOpfs();
        const locks = createFakeLockManager();
        const { store } = await createStore(fakeIdb, fakeOpfs, { requestLock: locks.request });
        const input = fixture();
        fakeIdb.failNextRequest(METADATA_STORE, 'put');

        await assert.rejects(store.saveCompletePackage(input.manifest, input.artifacts()));

        assert.equal(fakeOpfs.hasRevision(input.revision), false);
        assert.equal(fakeOpfs.hasFile(sharedAudioPath(input)), false);
        assert.deepEqual(fakeIdb.rawGetAll(METADATA_STORE), []);
    });

    await t.test('second metadata publication fails', async () => {
        const fakeIdb = createFakeIndexedDB();
        const fakeOpfs = createFakeOpfs();
        const locks = createFakeLockManager();
        const { store } = await createStore(fakeIdb, fakeOpfs, { requestLock: locks.request });
        const lead = fixture();
        const rhythm = secondArrangement(lead.audioBytes);
        await store.saveCompletePackage(lead.manifest, lead.artifacts());
        fakeIdb.failNextRequest(METADATA_STORE, 'put');

        await assert.rejects(store.saveCompletePackage(rhythm.manifest, rhythm.artifacts()));

        assert.equal(fakeOpfs.hasFile(sharedAudioPath(lead)), true);
        assert.equal((await store.readPackage(lead.revision)).metadata.revision, lead.revision);
        assert.equal(await store.readPackageMetadata(rhythm.revision), null);
    });
});

test('a failed second chart write leaves the first shared package usable', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const locks = createFakeLockManager();
    const { store } = await createStore(fakeIdb, fakeOpfs, {
        requestLock: locks.request,
    });
    const lead = fixture();
    const rhythm = secondArrangement(lead.audioBytes);
    await store.saveCompletePackage(lead.manifest, lead.artifacts());
    fakeOpfs.failNext('write', `practice-packages/${rhythm.revision}/chart.ndjson`);

    await assert.rejects(store.saveCompletePackage(rhythm.manifest, rhythm.artifacts()));

    assert.equal((await store.readPackage(lead.revision)).metadata.revision, lead.revision);
    assert.equal(await store.readPackageMetadata(rhythm.revision), null);
    assert.equal(fakeOpfs.hasFile(sharedAudioPath(lead)), true);
});

test('failed final shared cleanup hides metadata and leaves a safe orphan', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const locks = createFakeLockManager();
    const { module, store } = await createStore(fakeIdb, fakeOpfs, {
        requestLock: locks.request,
    });
    const input = fixture();
    await store.saveCompletePackage(input.manifest, input.artifacts());
    fakeOpfs.failNext('remove', sharedAudioPath(input));

    await assert.rejects(store.deletePackage(input.revision), module.PracticePackageStoreError);

    assert.equal(await store.readPackageMetadata(input.revision), null);
    assert.equal(fakeOpfs.hasRevision(input.revision), false);
    assert.equal(fakeOpfs.hasFile(sharedAudioPath(input)), true);
});

test('version changes close the cached database and the next metadata read reopens it', async () => {
    const fakeIdb = createFakeIndexedDB();
    const fakeOpfs = createFakeOpfs();
    const { store } = await createStore(fakeIdb, fakeOpfs);
    await store.open();

    fakeIdb.database.onversionchange();
    assert.equal(fakeIdb.state.closeCalls, 1);
    await store.listPackages();
    assert.equal(fakeIdb.state.openCalls, 2);
});
