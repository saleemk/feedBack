'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.join(
    __dirname, '..', '..', 'static', 'js', 'offline-artwork-cache.js',
);
let importSerial = 0;

async function loadModule() {
    importSerial += 1;
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    return import('data:text/javascript;base64,'
        + Buffer.from(source).toString('base64') + '#' + importSerial);
}

class FakeRequest {
    constructor(input, options = {}) {
        this.url = new URL(typeof input === 'string' ? input : input.url).href;
        this.method = options.method || 'GET';
        this.cache = options.cache || 'default';
    }
}

class FakeResponse {
    constructor(body, { status = 200, contentType = 'image/webp' } = {}) {
        this.body = body;
        this.status = status;
        this.ok = status >= 200 && status < 300;
        this.contentType = contentType;
        this.headers = { get: (name) => name.toLowerCase() === 'content-type' ? contentType : null };
    }
    clone() { return new FakeResponse(this.body, { status: this.status, contentType: this.contentType }); }
    async blob() { return this.body; }
}

function createCacheStorage() {
    const entries = new Map();
    const cache = {
        async match(request) { return entries.get(request.url)?.clone(); },
        async put(request, response) { entries.set(request.url, response.clone()); },
        async delete(request) { return entries.delete(request.url); },
    };
    return {
        entries,
        async open() { return cache; },
    };
}

test('artwork keys safely normalize filenames into the canonical same-origin route', async () => {
    const module = await loadModule();

    assert.equal(
        module.buildOfflineArtworkUrl(
            'Folder%2FSong%20One.sloppak',
            'https://feedback.test/v3/',
        ),
        'https://feedback.test/api/song/Folder%2FSong%20One.sloppak/art',
    );
    assert.equal(module.normalizeOfflineArtworkFilename('Song%20One.sloppak'), 'Song One.sloppak');
    assert.throws(() => module.buildOfflineArtworkUrl('', 'https://feedback.test/'), TypeError);
});

test('successful image artwork is fetched once per normalized song and read offline', async () => {
    const module = await loadModule();
    const cacheStorage = createCacheStorage();
    const fetches = [];
    const artwork = module.createOfflineArtworkCache({
        cacheStorage,
        Request: FakeRequest,
        baseHref: 'https://feedback.test/v3/',
        fetch: async (request) => {
            fetches.push(request);
            return new FakeResponse({ bytes: 'cover' });
        },
    });

    assert.deepEqual(await Promise.all([
        artwork.capture('Song%20One.sloppak'),
        artwork.capture('Song One.sloppak'),
    ]), [true, true]);
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0].cache, 'no-store');
    assert.deepEqual(await (await artwork.read('Song One.sloppak')).blob(), { bytes: 'cover' });
});

test('failed, missing, and non-image artwork are ignored without caching', async (t) => {
    const module = await loadModule();
    for (const [name, fetch] of [
        ['failed response', async () => new FakeResponse('missing', { status: 404 })],
        ['non-image response', async () => new FakeResponse('html', { contentType: 'text/html' })],
        ['network failure', async () => { throw new Error('offline'); }],
    ]) {
        await t.test(name, async () => {
            const cacheStorage = createCacheStorage();
            const artwork = module.createOfflineArtworkCache({
                cacheStorage,
                Request: FakeRequest,
                baseHref: 'https://feedback.test/',
                fetch,
            });
            assert.equal(await artwork.capture('Song.sloppak'), false);
            assert.equal(await artwork.read('Song.sloppak'), null);
            assert.equal(cacheStorage.entries.size, 0);
        });
    }
});

test('artwork removal deletes only the normalized song key', async () => {
    const module = await loadModule();
    const cacheStorage = createCacheStorage();
    const artwork = module.createOfflineArtworkCache({
        cacheStorage,
        Request: FakeRequest,
        baseHref: 'https://feedback.test/',
        fetch: async () => new FakeResponse('cover'),
    });
    await artwork.capture('Song%20One.sloppak');
    await artwork.capture('Other.sloppak');

    assert.equal(await artwork.remove('Song One.sloppak'), true);
    assert.equal(await artwork.read('Song One.sloppak'), null);
    assert.ok(await artwork.read('Other.sloppak'));
});
