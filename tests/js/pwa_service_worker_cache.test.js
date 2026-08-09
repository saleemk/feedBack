'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', 'static', 'v3', 'service-worker.js'),
    'utf8',
);
const ORIGIN = 'https://feedback.test';
const RECOVERY_CACHE = 'feedback-pwa-offline-v1';
const SHELL_CACHE = 'feedback-pwa-shell-v1';
const SHELL_MARKER = '/__feedback-pwa-shell-complete__';
const MANIFEST_URL = '/static/v3/pwa-shell-assets.json';
const PLUGINS_URL = '/api/plugins';

class FakeResponse {
    constructor(body = '', { status = 200, headers = {} } = {}) {
        this.body = String(body);
        this.status = status;
        this.headers = { ...headers };
        this.ok = status >= 200 && status < 300;
    }
    clone() { return new FakeResponse(this.body, this); }
    async json() { return JSON.parse(this.body); }
    async text() { return this.body; }
    static error() { return new FakeResponse('', { status: 0 }); }
}

class FakeRequest {
    constructor(input, options = {}) {
        const source = typeof input === 'string' ? { url: input } : input;
        this.url = new URL(source.url, ORIGIN).href;
        this.method = options.method || source.method || 'GET';
        this.mode = options.mode || source.mode || 'same-origin';
        this.cache = options.cache || source.cache || 'default';
    }
}

function urlPath(input) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, ORIGIN);
    return `${url.pathname}${url.search}`;
}

function createHarness({ responses = {}, seedCaches = {}, fetchHook = null } = {}) {
    const listeners = {};
    const operations = [];
    const fetches = [];
    const stores = new Map();
    let skipWaitingCalls = 0;
    let claimCalls = 0;

    async function fakeFetch(input) {
        const request = input instanceof FakeRequest ? input : new FakeRequest(input);
        fetches.push(request);
        if (fetchHook) return fetchHook(request, fetches.length - 1);
        const configured = responses[urlPath(request)];
        if (configured instanceof Error) throw configured;
        if (typeof configured === 'function') return configured(request);
        if (!configured) throw new Error(`No response configured for ${urlPath(request)}`);
        return configured.clone();
    }

    class FakeCache {
        constructor(name, entries = {}) {
            this.name = name;
            this.entries = new Map(
                Object.entries(entries).map(([key, response]) => [urlPath(key), response.clone()]),
            );
        }
        async match(request) {
            const response = this.entries.get(urlPath(request));
            return response ? response.clone() : undefined;
        }
        async put(request, response) {
            operations.push({ type: 'put', cache: this.name, url: urlPath(request) });
            this.entries.set(urlPath(request), response.clone());
        }
        async add(request) {
            operations.push({ type: 'add', cache: this.name, url: urlPath(request) });
            const response = await fakeFetch(request);
            if (!response.ok) throw new Error('cache.add received a non-OK response');
            await this.put(request, response);
        }
    }

    for (const [name, entries] of Object.entries(seedCaches)) {
        stores.set(name, new FakeCache(name, entries));
    }

    const caches = {
        async open(name) {
            if (!stores.has(name)) stores.set(name, new FakeCache(name));
            return stores.get(name);
        },
        async keys() { return Array.from(stores.keys()); },
        async delete(name) {
            operations.push({ type: 'delete', cache: name });
            return stores.delete(name);
        },
    };
    const self = {
        location: { origin: ORIGIN },
        clients: { async claim() { claimCalls += 1; } },
        async skipWaiting() { skipWaitingCalls += 1; },
        addEventListener(type, listener) { listeners[type] = listener; },
    };
    const context = vm.createContext({
        self,
        caches,
        fetch: fakeFetch,
        Request: FakeRequest,
        Response: FakeResponse,
        URL,
        Set,
        Promise,
        Error,
        decodeURIComponent,
        encodeURIComponent,
    });
    vm.runInContext(SOURCE, context, { filename: 'service-worker.js' });

    return {
        fetches,
        operations,
        hasCache: (name) => stores.has(name),
        cache: (name) => stores.get(name),
        skipWaitingCalls: () => skipWaitingCalls,
        claimCalls: () => claimCalls,
        async dispatchLifecycle(type) {
            let pending;
            listeners[type]({ waitUntil(value) { pending = value; } });
            await pending;
        },
        async dispatchFetch(request) {
            let responsePromise;
            listeners.fetch({
                request,
                respondWith(value) { responsePromise = value; },
            });
            return responsePromise ? responsePromise : undefined;
        },
    };
}

function successfulResponses() {
    const manifestBody = JSON.stringify({
        schema: 'feedback.pwa-shell-assets.v1',
        source: '/static/v3/index.html',
        assets: ['/static/app.js', '/static/v3/index.html'],
    });
    const pluginsBody = JSON.stringify([
        {
            id: 'mobile ui',
            status: 'ready',
            enabled: true,
            offline_assets: ['screen.js', 'src/main file.js'],
        },
        {
            id: 'mobile ui',
            status: 'ready',
            offline_assets: ['screen.js'],
        },
        { id: 'disabled', status: 'ready', enabled: false, offline_assets: ['screen.js'] },
        { id: 'pending', status: 'pending', offline_assets: ['screen.js'] },
        { id: 'installing', status: 'installing', offline_assets: ['screen.js'] },
        { id: 'failed', status: 'failed', offline_assets: ['screen.js'] },
        { id: 'empty', status: 'ready', offline_assets: [] },
    ]);
    return {
        manifestBody,
        pluginsBody,
        responses: {
            '/static/v3/offline.html': new FakeResponse('recovery'),
            [MANIFEST_URL]: new FakeResponse(manifestBody, { headers: { ETag: 'manifest' } }),
            [PLUGINS_URL]: new FakeResponse(pluginsBody, { headers: { ETag: 'plugins' } }),
            '/static/app.js': new FakeResponse('core app'),
            '/static/v3/index.html': new FakeResponse('core shell'),
            '/api/plugins/mobile%20ui/screen.js': new FakeResponse('plugin entry'),
            '/api/plugins/mobile%20ui/src/main%20file.js': new FakeResponse('plugin module'),
        },
    };
}

test('successful install publishes one complete shell candidate', async () => {
    const configured = successfulResponses();
    const harness = createHarness({ responses: configured.responses });

    await harness.dispatchLifecycle('install');

    assert.equal(harness.skipWaitingCalls(), 1);
    const shell = harness.cache(SHELL_CACHE);
    assert.ok(shell);
    assert.deepEqual(Array.from(shell.entries.keys()).sort(), [
        SHELL_MARKER,
        MANIFEST_URL,
        PLUGINS_URL,
        '/api/plugins/mobile%20ui/screen.js',
        '/api/plugins/mobile%20ui/src/main%20file.js',
        '/static/app.js',
        '/static/v3/index.html',
    ].sort());
    assert.equal(await (await shell.match(MANIFEST_URL)).text(), configured.manifestBody);
    assert.equal(await (await shell.match(PLUGINS_URL)).text(), configured.pluginsBody);

    const fetchedPaths = harness.fetches.map(urlPath);
    assert.equal(fetchedPaths.filter((url) => url === MANIFEST_URL).length, 1);
    assert.equal(fetchedPaths.filter((url) => url === PLUGINS_URL).length, 1);
    assert.equal(
        fetchedPaths.filter((url) => url === '/api/plugins/mobile%20ui/screen.js').length,
        1,
    );
    assert.equal(fetchedPaths.some((url) => url.includes('/disabled/')), false);
    assert.equal(fetchedPaths.some((url) => url.includes('/pending/')), false);
    assert.equal(fetchedPaths.some((url) => url.includes('/installing/')), false);
    assert.equal(fetchedPaths.some((url) => url.includes('/failed/')), false);
    assert.equal(harness.fetches.find((request) => urlPath(request) === MANIFEST_URL).cache,
        'no-store');
    assert.equal(harness.fetches.find((request) => urlPath(request) === PLUGINS_URL).cache,
        'no-store');

    const shellPuts = harness.operations.filter(
        (operation) => operation.type === 'put' && operation.cache === SHELL_CACHE,
    );
    assert.equal(shellPuts.at(-1).url, SHELL_MARKER);
});

test('required asset failure deletes the candidate without failing recovery install', async () => {
    const configured = successfulResponses();
    configured.responses['/static/app.js'] = new FakeResponse('failed', { status: 503 });
    const harness = createHarness({
        responses: configured.responses,
        seedCaches: {
            'feedback-pwa-shell-v0': { [SHELL_MARKER]: new FakeResponse('complete') },
        },
    });

    await harness.dispatchLifecycle('install');

    assert.equal(harness.skipWaitingCalls(), 1);
    assert.equal(harness.hasCache(SHELL_CACHE), false);
    assert.equal(harness.hasCache('feedback-pwa-shell-v0'), true);
    assert.equal(
        await (await harness.cache(RECOVERY_CACHE).match('/static/v3/offline.html')).text(),
        'recovery',
    );
});

test('malformed manifest or eligible plugin metadata fails the shell candidate closed', async () => {
    const cases = [
        {
            [MANIFEST_URL]: new FakeResponse(JSON.stringify({
                schema: 'feedback.pwa-shell-assets.v1',
                assets: ['/static/app.js', '/static/app.js'],
            })),
            [PLUGINS_URL]: new FakeResponse('[]'),
        },
        {
            [MANIFEST_URL]: new FakeResponse(JSON.stringify({
                schema: 'feedback.pwa-shell-assets.v1',
                assets: [],
            })),
            [PLUGINS_URL]: new FakeResponse(JSON.stringify([
                { id: 'broken', status: 'ready', offline_assets: 'screen.js' },
            ])),
        },
    ];

    for (const responses of cases) {
        responses['/static/v3/offline.html'] = new FakeResponse('recovery');
        const harness = createHarness({ responses });
        await harness.dispatchLifecycle('install');
        assert.equal(harness.hasCache(SHELL_CACHE), false);
        assert.equal(harness.skipWaitingCalls(), 1);
    }
});

test('activation preserves older shell caches when the current candidate is absent or incomplete', async () => {
    for (const currentEntries of [null, {}]) {
        const seedCaches = {
            [RECOVERY_CACHE]: { '/static/v3/offline.html': new FakeResponse('recovery') },
            'feedback-pwa-offline-v0': { '/old': new FakeResponse('old recovery') },
            'feedback-pwa-shell-v0': { [SHELL_MARKER]: new FakeResponse('complete') },
        };
        if (currentEntries) seedCaches[SHELL_CACHE] = currentEntries;
        const harness = createHarness({ seedCaches });

        await harness.dispatchLifecycle('activate');

        assert.equal(harness.hasCache('feedback-pwa-shell-v0'), true);
        assert.equal(harness.hasCache('feedback-pwa-offline-v0'), false);
        assert.equal(harness.claimCalls(), 1);
    }
});

test('activation removes older shell versions only when the current marker exists', async () => {
    const harness = createHarness({
        seedCaches: {
            [RECOVERY_CACHE]: { '/static/v3/offline.html': new FakeResponse('recovery') },
            [SHELL_CACHE]: { [SHELL_MARKER]: new FakeResponse('complete') },
            'feedback-pwa-shell-v0': { [SHELL_MARKER]: new FakeResponse('complete') },
            unrelated: { '/value': new FakeResponse('keep') },
        },
    });

    await harness.dispatchLifecycle('activate');

    assert.equal(harness.hasCache(SHELL_CACHE), true);
    assert.equal(harness.hasCache('feedback-pwa-shell-v0'), false);
    assert.equal(harness.hasCache('unrelated'), true);
    assert.equal(harness.claimCalls(), 1);
});

test('navigation remains network-first with the independent recovery fallback', async () => {
    const network = [
        new FakeResponse('online'),
        new FakeResponse('proxy unavailable', { status: 503 }),
        new Error('network down'),
    ];
    const harness = createHarness({
        seedCaches: {
            [RECOVERY_CACHE]: { '/static/v3/offline.html': new FakeResponse('recovery') },
            [SHELL_CACHE]: { '/v3': new FakeResponse('must not be served') },
        },
        fetchHook: async () => {
            const result = network.shift();
            if (result instanceof Error) throw result;
            return result;
        },
    });

    const request = () => new FakeRequest('/v3', { method: 'GET', mode: 'navigate' });
    assert.equal(await (await harness.dispatchFetch(request())).text(), 'online');
    assert.equal(await (await harness.dispatchFetch(request())).text(), 'recovery');
    assert.equal(await (await harness.dispatchFetch(request())).text(), 'recovery');
    assert.equal(harness.fetches.length, 3);
});
