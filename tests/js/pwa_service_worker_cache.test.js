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
const RECOVERY_CACHE = 'feedback-pwa-offline-v7';
const RECOVERY_ASSETS = [
    '/static/v3/offline.html',
    '/static/v3/offline-catalog.js',
    '/static/js/practice-package-store.js',
];
const SHELL_CACHE = 'feedback-pwa-shell-v7';
const PREVIOUS_SHELL_CACHE = 'feedback-pwa-shell-v6';
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
    const clientsById = new Map();

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
        async addAll(requests) {
            operations.push({ type: 'addAll', cache: this.name });
            const staged = [];
            for (const request of requests) {
                const response = await fakeFetch(request);
                if (!response.ok) throw new Error('cache.addAll received a non-OK response');
                staged.push([urlPath(request), response]);
            }
            for (const [url, response] of staged) {
                operations.push({ type: 'put', cache: this.name, url });
                this.entries.set(url, response.clone());
            }
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
        clients: {
            async claim() { claimCalls += 1; },
            async get(id) { return clientsById.get(id); },
        },
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
        async dispatchFetch(request, { clientUrl = null } = {}) {
            let responsePromise;
            const clientId = clientUrl ? 'test-client' : '';
            if (clientUrl) clientsById.set(clientId, { url: new URL(clientUrl, ORIGIN).href });
            listeners.fetch({
                request,
                clientId,
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
            has_script: true,
            script_type: 'module',
            has_settings: true,
            has_styles: true,
            styles: 'assets/mobile_ui.css',
            offline_assets: [
                'screen.js',
                'settings.html',
                'assets/mobile_ui.css',
                'src/main file.js',
            ],
        },
        {
            id: 'mobile ui',
            status: 'ready',
            offline_assets: ['screen.js'],
        },
        {
            id: 'section_map',
            status: 'ready',
            enabled: true,
            has_script: true,
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
            ...Object.fromEntries(
                RECOVERY_ASSETS.map((asset) => [asset, new FakeResponse('recovery')]),
            ),
            [MANIFEST_URL]: new FakeResponse(manifestBody, { headers: { ETag: 'manifest' } }),
            [PLUGINS_URL]: new FakeResponse(pluginsBody, { headers: { ETag: 'plugins' } }),
            '/static/app.js': new FakeResponse('core app'),
            '/static/v3/index.html': new FakeResponse('core shell'),
            '/api/plugins/mobile%20ui/screen.js': new FakeResponse('plugin entry'),
            '/api/plugins/mobile%20ui/settings.html': new FakeResponse('plugin settings'),
            '/api/plugins/mobile%20ui/assets/mobile_ui.css': new FakeResponse('plugin styles'),
            '/api/plugins/mobile%20ui/src/main%20file.js': new FakeResponse('plugin module'),
            '/api/plugins/section_map/screen.js': new FakeResponse('section map entry'),
        },
    };
}

test('successful install publishes one complete shell candidate', async () => {
    const configured = successfulResponses();
    const harness = createHarness({ responses: configured.responses });

    await harness.dispatchLifecycle('install');

    assert.equal(harness.skipWaitingCalls(), 1);
    assert.deepEqual(
        Array.from(harness.cache(RECOVERY_CACHE).entries.keys()).sort(),
        RECOVERY_ASSETS.slice().sort(),
    );
    const shell = harness.cache(SHELL_CACHE);
    assert.ok(shell);
    assert.deepEqual(Array.from(shell.entries.keys()).sort(), [
        SHELL_MARKER,
        MANIFEST_URL,
        PLUGINS_URL,
        '/api/plugins/mobile%20ui/assets/mobile_ui.css',
        '/api/plugins/mobile%20ui/screen.js',
        '/api/plugins/mobile%20ui/settings.html',
        '/api/plugins/mobile%20ui/src/main%20file.js',
        '/api/plugins/section_map/screen.js',
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
    assert.equal(
        fetchedPaths.filter((url) => url === '/api/plugins/section_map/screen.js').length,
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

test('v7 upgrade replaces v6 only after a complete candidate activates', async (t) => {
    await t.test('successful install builds v7 while preserving complete v6', async () => {
        const configured = successfulResponses();
        const harness = createHarness({
            responses: configured.responses,
            seedCaches: {
                [PREVIOUS_SHELL_CACHE]: { [SHELL_MARKER]: new FakeResponse('complete') },
            },
        });

        await harness.dispatchLifecycle('install');

        assert.equal(harness.hasCache(PREVIOUS_SHELL_CACHE), true);
        assert.equal(harness.hasCache(SHELL_CACHE), true);
        assert.equal(
            await (await harness.cache(SHELL_CACHE).match(SHELL_MARKER)).text(),
            'complete',
        );
    });

    await t.test('failed v7 install preserves complete v6', async () => {
        const configured = successfulResponses();
        configured.responses['/static/app.js'] = new FakeResponse('failed', { status: 503 });
        const harness = createHarness({
            responses: configured.responses,
            seedCaches: {
                [PREVIOUS_SHELL_CACHE]: { [SHELL_MARKER]: new FakeResponse('complete') },
            },
        });

        await harness.dispatchLifecycle('install');

        assert.equal(harness.hasCache(SHELL_CACHE), false);
        assert.equal(harness.hasCache(PREVIOUS_SHELL_CACHE), true);
    });

    await t.test('activation preserves v6 until v7 is complete', async () => {
        for (const currentEntries of [{}, { '/static/app.js': new FakeResponse('partial') }]) {
            const incomplete = createHarness({
                seedCaches: {
                    [SHELL_CACHE]: currentEntries,
                    [PREVIOUS_SHELL_CACHE]: {
                        [SHELL_MARKER]: new FakeResponse('complete'),
                    },
                },
            });
            await incomplete.dispatchLifecycle('activate');
            assert.equal(incomplete.hasCache(PREVIOUS_SHELL_CACHE), true);
        }

        const complete = createHarness({
            seedCaches: {
                [SHELL_CACHE]: { [SHELL_MARKER]: new FakeResponse('complete') },
                [PREVIOUS_SHELL_CACHE]: { [SHELL_MARKER]: new FakeResponse('complete') },
            },
        });
        await complete.dispatchLifecycle('activate');
        assert.equal(complete.hasCache(PREVIOUS_SHELL_CACHE), false);
        assert.equal(complete.hasCache(SHELL_CACHE), true);
    });
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

test('recovery asset failure publishes neither a partial cache nor the worker', async () => {
    const configured = successfulResponses();
    configured.responses['/static/v3/offline-catalog.js'] = new FakeResponse(
        'failed',
        { status: 503 },
    );
    const harness = createHarness({
        responses: configured.responses,
        seedCaches: {
            'feedback-pwa-offline-v1': {
                '/static/v3/offline.html': new FakeResponse('older recovery'),
            },
        },
    });

    await assert.rejects(harness.dispatchLifecycle('install'), /cache\.addAll/);
    assert.equal(harness.hasCache(RECOVERY_CACHE), false);
    assert.equal(harness.hasCache('feedback-pwa-offline-v1'), true);
    assert.equal(harness.hasCache(SHELL_CACHE), false);
    assert.equal(harness.skipWaitingCalls(), 0);
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
        for (const asset of RECOVERY_ASSETS) {
            responses[asset] = new FakeResponse('recovery');
        }
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

test('matching current shell resources stay network-first and mask only transient failures', async () => {
    const network = [
        new FakeResponse('online'),
        new Error('network down'),
        new FakeResponse('bad gateway', { status: 502 }),
        new FakeResponse('unavailable', { status: 503 }),
        new FakeResponse('timeout', { status: 504 }),
        new FakeResponse('missing', { status: 404 }),
        new FakeResponse('server error', { status: 500 }),
    ];
    const harness = createHarness({
        seedCaches: {
            [SHELL_CACHE]: {
                [SHELL_MARKER]: new FakeResponse('complete'),
                '/static/app.js': new FakeResponse('cached app'),
            },
            'feedback-pwa-shell-v0': {
                [SHELL_MARKER]: new FakeResponse('complete'),
                '/static/app.js': new FakeResponse('older cached app'),
            },
        },
        fetchHook: async () => {
            const result = network.shift();
            if (result instanceof Error) throw result;
            return result;
        },
    });
    const request = () => new FakeRequest('/static/app.js');

    assert.equal(await (await harness.dispatchFetch(request())).text(), 'online');
    for (let index = 0; index < 4; index += 1) {
        assert.equal(await (await harness.dispatchFetch(request())).text(), 'cached app');
    }
    const missing = await harness.dispatchFetch(request());
    const serverError = await harness.dispatchFetch(request());
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), 'missing');
    assert.equal(serverError.status, 500);
    assert.equal(await serverError.text(), 'server error');
    assert.equal(harness.fetches.length, 7);
});

test('matching recovery resources stay network-first with exact cached fallback', async () => {
    const network = [
        new FakeResponse('online module'),
        new Error('network down'),
        new FakeResponse('bad gateway', { status: 502 }),
        new FakeResponse('unavailable', { status: 503 }),
        new FakeResponse('timeout', { status: 504 }),
        new FakeResponse('missing', { status: 404 }),
        new FakeResponse('server error', { status: 500 }),
        new FakeResponse('query unavailable', { status: 503 }),
    ];
    const harness = createHarness({
        seedCaches: {
            [RECOVERY_CACHE]: {
                '/static/v3/offline-catalog.js': new FakeResponse('cached module'),
            },
        },
        fetchHook: async () => {
            const result = network.shift();
            if (result instanceof Error) throw result;
            return result;
        },
    });
    const request = () => new FakeRequest('/static/v3/offline-catalog.js');

    assert.equal(await (await harness.dispatchFetch(request())).text(), 'online module');
    for (let index = 0; index < 4; index += 1) {
        assert.equal(await (await harness.dispatchFetch(request())).text(), 'cached module');
    }
    assert.equal((await harness.dispatchFetch(request())).status, 404);
    assert.equal((await harness.dispatchFetch(request())).status, 500);
    const queryMismatch = await harness.dispatchFetch(
        new FakeRequest('/static/v3/offline-catalog.js?v=1'),
    );
    assert.equal(queryMismatch.status, 503);
    assert.equal(await queryMismatch.text(), 'query unavailable');
    assert.equal(harness.fetches.length, 8);
});

test('plugin discovery and versioned stable assets use their exact cached snapshots', async () => {
    const harness = createHarness({
        seedCaches: {
            [SHELL_CACHE]: {
                [SHELL_MARKER]: new FakeResponse('complete'),
                [PLUGINS_URL]: new FakeResponse('cached plugins'),
                '/api/plugins/mobile%20ui/screen.js': new FakeResponse('cached plugin'),
            },
        },
        fetchHook: async () => { throw new Error('network down'); },
    });

    assert.equal(
        await (await harness.dispatchFetch(new FakeRequest(PLUGINS_URL))).text(),
        'cached plugins',
    );
    assert.equal(
        await (await harness.dispatchFetch(
            new FakeRequest('/api/plugins/mobile%20ui/screen.js?v=0.4.0'),
        )).text(),
        'cached plugin',
    );
    await assert.rejects(
        harness.dispatchFetch(new FakeRequest('/api/plugins/mobile%20ui/g/1/screen.js?v=0.4.0')),
        /network down/,
    );
});

test('explicit offline navigation serves the cached real shell without network access', async () => {
    const harness = createHarness({
        seedCaches: {
            [RECOVERY_CACHE]: { '/static/v3/offline.html': new FakeResponse('recovery') },
            [SHELL_CACHE]: {
                [SHELL_MARKER]: new FakeResponse('complete'),
                '/static/v3/index.html': new FakeResponse('cached real shell'),
            },
        },
        fetchHook: async () => { throw new Error('network must not run'); },
    });

    const response = await harness.dispatchFetch(new FakeRequest(
        `/v3/?offline=1&revision=${'a'.repeat(64)}`,
        { mode: 'navigate' },
    ));
    assert.equal(await response.text(), 'cached real shell');
    assert.equal(harness.fetches.length, 0);
});

test('explicit offline navigation falls back to recovery without a complete shell', async () => {
    for (const shellEntries of [null, { '/static/v3/index.html': new FakeResponse('partial') }]) {
        const seedCaches = {
            [RECOVERY_CACHE]: { '/static/v3/offline.html': new FakeResponse('recovery') },
        };
        if (shellEntries) seedCaches[SHELL_CACHE] = shellEntries;
        const harness = createHarness({ seedCaches });
        const response = await harness.dispatchFetch(new FakeRequest(
            '/v3/?offline=1',
            { mode: 'navigate' },
        ));
        assert.equal(await response.text(), 'recovery');
        assert.equal(harness.fetches.length, 0);
    }
});

test('offline app clients use cached core and eligible plugin snapshots only', async () => {
    const plugins = [
        {
            id: 'mobile ui', status: 'ready', enabled: true,
            has_script: true, script_type: 'module', has_settings: true,
            has_styles: true, styles: 'assets/mobile_ui.css',
            offline_assets: ['screen.js', 'settings.html', 'assets/mobile_ui.css'],
        },
        {
            id: 'highway_3d', status: 'ready', enabled: true,
            has_script: true, has_settings: true, has_styles: true,
            styles: 'assets/plugin.css',
            offline_assets: ['screen.js', 'settings.html', 'assets/plugin.css'],
        },
        {
            id: 'section_map', status: 'ready', enabled: true,
            has_script: true, offline_assets: ['screen.js'],
        },
        {
            id: 'mobile ui missing settings', status: 'ready', enabled: true,
            has_script: true, script_type: 'module', has_settings: true,
            has_styles: true, styles: 'assets/mobile_ui.css',
            offline_assets: ['screen.js', 'assets/mobile_ui.css'],
        },
        {
            id: 'partial-style', status: 'ready', enabled: true,
            has_script: true, has_styles: true, styles: 'assets/plugin.css',
            offline_assets: ['screen.js'],
        },
        {
            id: 'online only', status: 'ready', enabled: true,
            has_script: true, offline_assets: [],
        },
    ];
    const harness = createHarness({
        seedCaches: {
            [SHELL_CACHE]: {
                [SHELL_MARKER]: new FakeResponse('complete'),
                '/static/app.js': new FakeResponse('cached app'),
                [PLUGINS_URL]: new FakeResponse(JSON.stringify(plugins)),
                '/api/plugins/mobile%20ui/screen.js': new FakeResponse('cached plugin'),
                '/api/plugins/mobile%20ui/settings.html': new FakeResponse('cached settings'),
                '/api/plugins/mobile%20ui/assets/mobile_ui.css': new FakeResponse('cached styles'),
                '/api/plugins/section_map/screen.js': new FakeResponse('cached section map'),
            },
        },
        fetchHook: async () => { throw new Error('network must not run'); },
    });
    const options = { clientUrl: `/v3/?offline=1` };

    assert.equal(
        await (await harness.dispatchFetch(new FakeRequest('/static/app.js'), options)).text(),
        'cached app',
    );
    const discovery = await (await harness.dispatchFetch(
        new FakeRequest(PLUGINS_URL), options,
    )).json();
    assert.deepEqual(discovery, [plugins[0], plugins[1], plugins[2]]);
    assert.equal(
        discovery.some((plugin) => plugin.id === 'mobile ui missing settings'),
        false,
    );
    assert.equal(
        await (await harness.dispatchFetch(
            new FakeRequest('/api/plugins/mobile%20ui/screen.js?v=1'), options,
        )).text(),
        'cached plugin',
    );
    assert.equal(
        await (await harness.dispatchFetch(
            new FakeRequest('/api/plugins/section_map/screen.js?v=1.1.0'), options,
        )).text(),
        'cached section map',
    );
    assert.equal(
        (await harness.dispatchFetch(new FakeRequest('/static/not-cached.js'), options)).status,
        0,
    );
    assert.equal(harness.fetches.length, 0);
});

test('direct recovery navigation always returns the cached package list', async () => {
    const harness = createHarness({
        seedCaches: {
            [RECOVERY_CACHE]: { '/static/v3/offline.html': new FakeResponse('recovery') },
        },
        fetchHook: async () => { throw new Error('network must not run'); },
    });
    const response = await harness.dispatchFetch(new FakeRequest(
        '/static/v3/offline.html',
        { mode: 'navigate' },
    ));
    assert.equal(await response.text(), 'recovery');
    assert.equal(harness.fetches.length, 0);
});

test('incomplete current caches are skipped in favor of complete preserved caches', async () => {
    const incompleteOnly = createHarness({
        seedCaches: {
            [SHELL_CACHE]: { '/static/app.js': new FakeResponse('incomplete') },
        },
        fetchHook: async () => { throw new Error('network down'); },
    });
    await assert.rejects(
        incompleteOnly.dispatchFetch(new FakeRequest('/static/app.js')),
        /network down/,
    );

    for (const currentEntries of [null, {
        '/static/app.js': new FakeResponse('incomplete current'),
    }]) {
        const seedCaches = {
            'feedback-pwa-shell-legacy': {
                [SHELL_MARKER]: new FakeResponse('complete'),
                '/static/app.js': new FakeResponse('older preserved app'),
            },
            'feedback-pwa-shell-v0': {
                [SHELL_MARKER]: new FakeResponse('complete'),
                '/static/app.js': new FakeResponse('preserved app'),
            },
        };
        if (currentEntries) seedCaches[SHELL_CACHE] = currentEntries;
        const harness = createHarness({
            seedCaches,
            fetchHook: async () => { throw new Error('network down'); },
        });

        assert.equal(
            await (await harness.dispatchFetch(new FakeRequest('/static/app.js'))).text(),
            'preserved app',
        );
    }
});

test('uncached resources and unrelated APIs keep ordinary network behavior', async () => {
    const harness = createHarness({
        seedCaches: {
            [SHELL_CACHE]: {
                [SHELL_MARKER]: new FakeResponse('complete'),
                '/static/app.js': new FakeResponse('cached app'),
            },
        },
        fetchHook: async () => new FakeResponse('unavailable', { status: 503 }),
    });

    assert.equal(await harness.dispatchFetch(new FakeRequest('/api/profile')), undefined);
    const uncached = await harness.dispatchFetch(new FakeRequest('/static/uncached.js'));
    const queryMismatch = await harness.dispatchFetch(new FakeRequest('/static/app.js?v=1'));
    assert.equal(uncached.status, 503);
    assert.equal(queryMismatch.status, 503);
    assert.equal(harness.fetches.length, 2);
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
            [SHELL_CACHE]: {
                [SHELL_MARKER]: new FakeResponse('complete'),
                '/v3': new FakeResponse('must not be served'),
                '/static/v3/index.html': new FakeResponse('cached shell'),
            },
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
