'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_PATH = path.join(ROOT, 'static', 'js', 'device-catalog-capture.js');
const APP_PATH = path.join(ROOT, 'static', 'app.js');
let importSerial = 0;

function moduleUrl(filePath) {
    const source = fs.readFileSync(filePath, 'utf8');
    return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

async function loadModule() {
    const availabilityUrl = moduleUrl(path.join(ROOT, 'static', 'js', 'app-availability.js'));
    const catalogUrl = moduleUrl(path.join(ROOT, 'static', 'js', 'device-catalog.js'));
    const source = fs.readFileSync(MODULE_PATH, 'utf8')
        .replace('./app-availability.js', availabilityUrl)
        .replace('./device-catalog.js', catalogUrl);
    importSerial += 1;
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${importSerial}`);
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((done, fail) => {
        resolve = done;
        reject = fail;
    });
    return { promise, resolve, reject };
}

function response(body, { ok = true } = {}) {
    return { ok, json: async () => body };
}

function createEventBus() {
    const listeners = new Set();
    const state = { onCalls: 0, offCalls: 0 };
    return {
        state,
        on(event, listener) {
            assert.equal(event, 'library:changed');
            state.onCalls += 1;
            listeners.add(listener);
        },
        off(event, listener) {
            assert.equal(event, 'library:changed');
            state.offCalls += 1;
            listeners.delete(listener);
        },
        emit() {
            for (const listener of listeners) listener();
        },
    };
}

function createTimers() {
    let nextToken = 1;
    const pending = new Map();
    const cancelled = [];
    return {
        pending,
        cancelled,
        scheduleTimeout(callback, delay) {
            const token = nextToken;
            nextToken += 1;
            pending.set(token, { callback, delay });
            return token;
        },
        cancelTimeout(token) {
            cancelled.push(token);
            pending.delete(token);
        },
        runAll() {
            const scheduled = Array.from(pending.values());
            pending.clear();
            for (const { callback } of scheduled) callback();
        },
    };
}

async function settle() {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function waitFor(predicate) {
    for (let index = 0; index < 50; index += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    assert.fail('condition did not settle');
}

test('startup is synchronous, background-only, and contains failures', async () => {
    const module = await loadModule();
    const availability = deferred();
    const bus = createEventBus();
    let fetchCalls = 0;
    const capture = module.createDeviceCatalogCapture({
        availabilityCheck: () => availability.promise,
        fetch: async () => { fetchCalls += 1; },
        replaceSnapshot: async () => {},
        eventBus: bus,
    });

    const cleanup = capture.start();
    assert.equal(typeof cleanup, 'function');
    assert.equal(bus.state.onCalls, 1);
    assert.equal(fetchCalls, 0);

    availability.reject(new Error('availability failed'));
    await settle();
    assert.equal(fetchCalls, 0);

    const app = fs.readFileSync(APP_PATH, 'utf8');
    assert.match(app, /import\s*\{\s*startDeviceCatalogCapture\s*\}/);
    assert.match(app, /window\.feedBack\s*=\s*Object\.assign[\s\S]*?startDeviceCatalogCapture\(window\.feedBack\);/);
    assert.doesNotMatch(app, /await\s+startDeviceCatalogCapture/);
});

test('online idle capture forwards one unchanged snapshot with uncached requests', async () => {
    const module = await loadModule();
    const snapshot = { schema: 'server-owned', songs: [{ future: true }] };
    const requests = [];
    const replacements = [];
    const replies = [response({ running: false }), response(snapshot)];
    const capture = module.createDeviceCatalogCapture({
        availabilityCheck: async () => ({ state: 'online' }),
        fetch: async (url, options) => {
            requests.push({ url, options });
            return replies.shift();
        },
        replaceSnapshot: async (value) => { replacements.push(value); },
    });

    assert.equal(await capture.requestCapture(), true);
    assert.deepEqual(requests.map(({ url }) => url), [
        '/api/scan-status',
        '/api/library/device-catalog',
    ]);
    for (const { options } of requests) {
        assert.deepEqual(options, { cache: 'no-store', credentials: 'same-origin' });
    }
    assert.equal(replacements.length, 1);
    assert.equal(replacements[0], snapshot);
});

test('cached-shell and server-unavailable states do not fetch catalog data', async (t) => {
    const module = await loadModule();
    for (const state of [
        'cached-shell',
        'server-unavailable',
    ]) {
        await t.test(state, async () => {
            let fetchCalls = 0;
            const capture = module.createDeviceCatalogCapture({
                availabilityCheck: async () => ({ state }),
                fetch: async () => { fetchCalls += 1; },
                replaceSnapshot: async () => assert.fail('must not replace'),
            });
            assert.equal(await capture.requestCapture(), false);
            assert.equal(fetchCalls, 0);
        });
    }
});

test('running, failed, non-OK, and malformed scan status do not mutate storage', async (t) => {
    const module = await loadModule();
    const cases = [
        ['request failure', async () => { throw new Error('network'); }],
        ['non-OK response', async () => response({}, { ok: false })],
        ['malformed response', async () => response({})],
        ['running scan', async () => response({ running: true })],
        ['failed scan', async () => response({ running: false, error: 'scan failed' })],
        ['error stage', async () => response({ running: false, stage: 'error' })],
        ['malformed JSON', async () => ({ ok: true, json: async () => { throw new Error('json'); } })],
    ];

    for (const [label, fetchScan] of cases) {
        await t.test(label, async () => {
            let replacements = 0;
            const capture = module.createDeviceCatalogCapture({
                availabilityCheck: async () => ({ state: 'online' }),
                fetch: fetchScan,
                replaceSnapshot: async () => { replacements += 1; },
            });
            assert.equal(await capture.requestCapture(), false);
            assert.equal(replacements, 0);
        });
    }
});

test('endpoint and replacement failures preserve the previous snapshot', async (t) => {
    const module = await loadModule();
    const previous = { revision: 'previous' };
    const serverSnapshot = { revision: 'next' };
    const cases = [
        ['endpoint request failure', async () => { throw new Error('network'); }, async () => {}],
        ['endpoint non-OK', async () => response({}, { ok: false }), async () => {}],
        ['endpoint malformed JSON', async () => ({ ok: true, json: async () => { throw new Error('json'); } }), async () => {}],
        ['replacement failure', async () => response(serverSnapshot), async () => { throw new Error('quota'); }],
    ];

    for (const [label, fetchCatalog, replaceSnapshot] of cases) {
        await t.test(label, async () => {
            let stored = previous;
            let requestCount = 0;
            const capture = module.createDeviceCatalogCapture({
                availabilityCheck: async () => ({ state: 'online' }),
                fetch: async (...args) => {
                    requestCount += 1;
                    if (requestCount === 1) return response({ running: false });
                    return fetchCatalog(...args);
                },
                replaceSnapshot: async (value) => {
                    await replaceSnapshot(value);
                    stored = value;
                },
            });
            assert.equal(await capture.requestCapture(), false);
            assert.equal(stored, previous);
        });
    }
});

test('library change bursts debounce into one capture attempt', async () => {
    const module = await loadModule();
    const bus = createEventBus();
    const timers = createTimers();
    let checks = 0;
    const capture = module.createDeviceCatalogCapture({
        availabilityCheck: async () => {
            checks += 1;
            return { state: 'cached-shell' };
        },
        eventBus: bus,
        debounceMs: 25,
        ...timers,
    });
    capture.start();
    await waitFor(() => checks === 1);
    await settle();

    bus.emit();
    bus.emit();
    bus.emit();
    assert.equal(timers.pending.size, 1);
    assert.equal(Array.from(timers.pending.values())[0].delay, 25);
    timers.runAll();
    await waitFor(() => checks === 2);
    assert.equal(checks, 2);
});

test('an event during an active attempt queues at most one follow-up', async () => {
    const module = await loadModule();
    const bus = createEventBus();
    const timers = createTimers();
    const firstAvailability = deferred();
    let checks = 0;
    const capture = module.createDeviceCatalogCapture({
        availabilityCheck: () => {
            checks += 1;
            if (checks === 1) return firstAvailability.promise;
            return Promise.resolve({ state: 'cached-shell' });
        },
        fetch: async () => assert.fail('offline attempts must not fetch'),
        eventBus: bus,
        ...timers,
    });
    capture.start();
    await waitFor(() => checks === 1);

    bus.emit();
    bus.emit();
    assert.equal(timers.pending.size, 0);
    firstAvailability.resolve({ state: 'cached-shell' });
    await waitFor(() => checks === 2);
    await settle();
    assert.equal(checks, 2);
});

test('cleanup removes the listener, cancels debounce, and is idempotent', async () => {
    const module = await loadModule();
    const bus = createEventBus();
    const timers = createTimers();
    let checks = 0;
    const capture = module.createDeviceCatalogCapture({
        availabilityCheck: async () => {
            checks += 1;
            return { state: 'cached-shell' };
        },
        eventBus: bus,
        ...timers,
    });
    const cleanup = capture.start();
    await waitFor(() => checks === 1);
    await settle();
    bus.emit();
    assert.equal(timers.pending.size, 1);

    cleanup();
    cleanup();
    assert.equal(bus.state.offCalls, 1);
    assert.equal(timers.pending.size, 0);
    assert.equal(timers.cancelled.length, 1);
    bus.emit();
    timers.runAll();
    await settle();
    assert.equal(checks, 1);
});
