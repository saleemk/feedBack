'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_PATH = path.join(ROOT, 'static', 'v3', 'offline-catalog.js');
const HTML_PATH = path.join(ROOT, 'static', 'v3', 'offline.html');
const MANIFEST_PATH = path.join(ROOT, 'static', 'v3', 'pwa-shell-assets.json');
const SONG_A = 'a'.repeat(64);
const SONG_B = 'b'.repeat(64);
const SONG_C = 'c'.repeat(64);
const SONG_D = 'd'.repeat(64);
let importSerial = 0;

async function loadModule() {
    const catalogPath = path.join(ROOT, 'static', 'js', 'device-catalog.js');
    const catalogSource = fs.readFileSync(catalogPath, 'utf8');
    const catalogUrl = `data:text/javascript;base64,${Buffer.from(catalogSource).toString('base64')}`;
    const source = fs.readFileSync(MODULE_PATH, 'utf8')
        .replace('../js/device-catalog.js', catalogUrl);
    importSerial += 1;
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${importSerial}`);
}

class FakeElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.hidden = false;
        this.textContent = '';
        this.className = '';
        this.value = '';
        this.children = [];
        this.attributes = new Map();
        this.listeners = new Map();
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    getAttribute(name) {
        return this.attributes.get(name);
    }

    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
    }

    dispatch(type) {
        for (const listener of this.listeners.get(type) || []) listener({ target: this });
    }

    append(...children) {
        this.children.push(...children);
    }

    replaceChildren(...children) {
        this.children = children.slice();
    }
}

function createDocument() {
    const elements = new Map();
    const ids = [
        'offline-recovery',
        'offline-app',
        'offline-home',
        'offline-library',
        'offline-nav-home',
        'offline-nav-library',
        'offline-song-count',
        'offline-captured-at',
        'offline-browse-library',
        'offline-search',
        'offline-song-list',
        'offline-result-count',
        'offline-library-empty',
    ];
    for (const id of ids) elements.set(id, new FakeElement());
    elements.get('offline-app').hidden = true;
    elements.get('offline-library').hidden = true;
    elements.get('offline-library-empty').hidden = true;
    return {
        elements,
        getElementById(id) { return elements.get(id) || null; },
        createElement(tagName) { return new FakeElement(tagName); },
    };
}

function snapshot(songs, capturedAt = 1700000000000) {
    return {
        metadata: { count: songs.length, capturedAt },
        songs,
    };
}

test('recovery document remains useful and Retry is independent of the module', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const inlineRetry = html.indexOf("window.location.reload()");
    const moduleScript = html.indexOf('src="/static/v3/offline-catalog.js"');

    assert.match(html, /Can't reach your fee\[dB\]ack server/);
    assert.match(html, /does not mean your songs or profile data were lost/);
    assert.ok(inlineRetry > 0);
    assert.ok(moduleScript > inlineRetry);
    assert.match(html, /id="offline-app" hidden/);
});

test('a valid snapshot reveals Offline Home with count and local capture time', async () => {
    const module = await loadModule();
    const document = createDocument();
    const songs = [{ id: SONG_A, title: 'First', artist: 'Artist' }];
    const controller = module.createOfflineCatalog({
        document,
        readSnapshot: async () => snapshot(songs),
        formatCapturedAt: (value) => `local-${value}`,
    });

    assert.equal(await controller.start(), true);
    assert.equal(document.elements.get('offline-recovery').hidden, true);
    assert.equal(document.elements.get('offline-app').hidden, false);
    assert.equal(document.elements.get('offline-home').hidden, false);
    assert.equal(document.elements.get('offline-library').hidden, true);
    assert.equal(document.elements.get('offline-song-count').textContent, '1 song available');
    assert.equal(
        document.elements.get('offline-captured-at').textContent,
        'Captured local-1700000000000',
    );
    assert.equal(document.elements.get('offline-nav-home').getAttribute('aria-current'), 'page');
    assert.equal(document.elements.get('offline-nav-library').getAttribute('aria-current'), undefined);
    assert.match(fs.readFileSync(HTML_PATH, 'utf8'), /browse-only[\s\S]*Playback requires reconnecting/);
});

test('a valid zero-song snapshot is an available empty catalog', async () => {
    const module = await loadModule();
    const document = createDocument();
    const controller = module.createOfflineCatalog({
        document,
        readSnapshot: async () => snapshot([]),
        formatCapturedAt: () => 'now',
    });

    assert.equal(await controller.start(), true);
    document.elements.get('offline-browse-library').dispatch('click');
    assert.equal(document.elements.get('offline-song-count').textContent, '0 songs available');
    assert.equal(document.elements.get('offline-result-count').textContent, '0 songs of 0 songs');
    assert.equal(document.elements.get('offline-library-empty').hidden, false);
    assert.equal(
        document.elements.get('offline-library-empty').textContent,
        'No songs were captured on this device.',
    );
});

test('missing, unavailable, or invalid storage leaves recovery visible', async (t) => {
    const module = await loadModule();
    const cases = [
        ['missing', async () => null],
        ['unavailable', async () => { throw new Error('IndexedDB denied'); }],
        ['invalid', async () => { throw new Error('invalid snapshot'); }],
    ];
    for (const [label, readSnapshot] of cases) {
        await t.test(label, async () => {
            const document = createDocument();
            const controller = module.createOfflineCatalog({ document, readSnapshot });
            assert.equal(await controller.start(), false);
            assert.equal(document.elements.get('offline-recovery').hidden, false);
            assert.equal(document.elements.get('offline-app').hidden, true);
        });
    }
});

test('Library sorts deterministically and searches title and artist locally', async () => {
    const module = await loadModule();
    const document = createDocument();
    let reads = 0;
    const songs = [
        { id: SONG_D, title: 'First', artist: 'Beta' },
        { id: SONG_C, title: 'Same', artist: 'alpha' },
        { id: SONG_A, title: 'Able', artist: 'Alpha' },
        { id: SONG_B, title: 'same', artist: 'Alpha' },
    ];
    const controller = module.createOfflineCatalog({
        document,
        readSnapshot: async () => { reads += 1; return snapshot(songs); },
        formatCapturedAt: () => 'now',
    });
    await controller.start();
    document.elements.get('offline-nav-library').dispatch('click');

    const list = document.elements.get('offline-song-list');
    assert.deepEqual(list.children.map((row) => row.children[0].textContent), [
        'Able',
        'same',
        'Same',
        'First',
    ]);
    const search = document.elements.get('offline-search');
    search.value = 'BETA';
    search.dispatch('input');
    assert.deepEqual(list.children.map((row) => row.children[0].textContent), ['First']);
    search.value = 'same';
    search.dispatch('input');
    assert.deepEqual(list.children.map((row) => row.children[0].textContent), ['same', 'Same']);
    assert.equal(document.elements.get('offline-result-count').textContent, '2 songs of 4 songs');
    assert.equal(reads, 1);
});

test('song values render only as non-interactive text without opaque ids', async () => {
    const module = await loadModule();
    const document = createDocument();
    const song = {
        id: SONG_A,
        title: '<button>Play</button>',
        artist: '<img src=x onerror=alert(1)>',
    };
    const controller = module.createOfflineCatalog({
        document,
        readSnapshot: async () => snapshot([song]),
        formatCapturedAt: () => 'now',
    });
    await controller.start();

    const row = document.elements.get('offline-song-list').children[0];
    assert.equal(row.tagName, 'LI');
    assert.equal(row.listeners.size, 0);
    assert.equal(row.children[0].textContent, song.title);
    assert.equal(row.children[1].textContent, song.artist);
    assert.equal(row.children.some((child) => child.textContent.includes(SONG_A)), false);
    assert.doesNotMatch(fs.readFileSync(MODULE_PATH, 'utf8'), /innerHTML/);
});

test('Home and Library controls change only the local offline view', async () => {
    const module = await loadModule();
    const document = createDocument();
    const controller = module.createOfflineCatalog({
        document,
        readSnapshot: async () => snapshot([]),
        formatCapturedAt: () => 'now',
    });
    await controller.start();

    document.elements.get('offline-nav-library').dispatch('click');
    assert.equal(document.elements.get('offline-home').hidden, true);
    assert.equal(document.elements.get('offline-library').hidden, false);
    assert.equal(document.elements.get('offline-nav-library').getAttribute('aria-current'), 'page');
    assert.equal(document.elements.get('offline-nav-home').getAttribute('aria-current'), undefined);
    document.elements.get('offline-nav-home').dispatch('click');
    assert.equal(document.elements.get('offline-home').hidden, false);
    assert.equal(document.elements.get('offline-library').hidden, true);
});

test('offline module has no network or normal-shell dependency and stays outside shell manifest', () => {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

    assert.match(source, /readDeviceCatalogSnapshot/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /app\.js|plugin/i);
    assert.match(html, /\.destination\[aria-current="page"\]/);
    assert.doesNotMatch(html, /\.destination\[aria-selected=/);
    assert.equal(manifest.assets.includes('/static/v3/offline.html'), false);
    assert.equal(manifest.assets.includes('/static/v3/offline-catalog.js'), false);
});
