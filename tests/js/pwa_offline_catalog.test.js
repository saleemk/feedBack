'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_PATH = path.join(ROOT, 'static', 'v3', 'offline-catalog.js');
const HTML_PATH = path.join(ROOT, 'static', 'v3', 'offline.html');
const STORE_PATH = path.join(ROOT, 'static', 'js', 'practice-package-store.js');
const REVISION_A = 'a'.repeat(64);
const REVISION_B = 'b'.repeat(64);
let importSerial = 0;

async function loadModule() {
    const storeSource = fs.readFileSync(STORE_PATH, 'utf8');
    const storeUrl = `data:text/javascript;base64,${Buffer.from(storeSource).toString('base64')}`;
    const artworkSource = fs.readFileSync(
        path.join(ROOT, 'static', 'js', 'offline-artwork-cache.js'),
        'utf8',
    );
    const artworkUrl = `data:text/javascript;base64,${Buffer.from(artworkSource).toString('base64')}`;
    const source = fs.readFileSync(MODULE_PATH, 'utf8')
        .replace('../js/practice-package-store.js', storeUrl)
        .replace('../js/offline-artwork-cache.js', artworkUrl);
    importSerial += 1;
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${importSerial}`);
}

class FakeElement {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.hidden = false;
        this.textContent = '';
        this.className = '';
        this.type = '';
        this.disabled = false;
        this.children = [];
        this.attributes = new Map();
        this.listeners = new Map();
    }

    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name); }
    addEventListener(type, listener) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type).add(listener);
    }
    dispatch(type) {
        return Promise.all(Array.from(this.listeners.get(type) || [], (listener) => (
            listener({ target: this, currentTarget: this })
        )));
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children.slice(); }
}

function createDocument() {
    const ids = [
        'offline-storage-loading',
        'offline-package-manager',
        'offline-package-count',
        'offline-storage-usage',
        'offline-package-list',
        'offline-package-empty',
        'offline-storage-error',
    ];
    const elements = new Map(ids.map((id) => [id, new FakeElement()]));
    elements.get('offline-package-manager').hidden = true;
    elements.get('offline-package-empty').hidden = true;
    elements.get('offline-storage-error').hidden = true;
    return {
        elements,
        getElementById(id) { return elements.get(id) || null; },
        createElement(tagName) { return new FakeElement(tagName); },
    };
}

function metadata(revision, {
    title = 'Stored Song', artist = 'Stored Artist', filename = `${title}.sloppak`,
    arrangementIndex = 0, arrangementName = 'Lead', complete = true,
} = {}) {
    return {
        revision,
        complete,
        source: { filename },
        song: { title, artist },
        arrangement: { index: arrangementIndex, name: arrangementName },
        chart: { bytes: 1024 },
        audio: { bytes: 4 * 1024 * 1024 },
    };
}

test('recovery document is package-only and Retry remains independent', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    assert.match(html, /<h1 id="offline-title">Offline practice<\/h1>/);
    assert.match(html, /Open downloaded songs while your server is unavailable\./);
    assert.doesNotMatch(html, /Downloaded practice|Reconnect and reload|practice packages saved/);
    assert.match(html, /id="offline-package-list"/);
    assert.match(html, /id="offline-storage-usage"/);
    assert.match(html, /\.package-artwork[\s\S]*aspect-ratio: 1/);
    assert.match(html, /\.package-artwork-fallback/);
    assert.match(html, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(html, /\.package-actions button \{ min-height: 2\.75rem/);
    assert.match(html, /window\.location\.assign\('\/v3\/'\)/);
    assert.doesNotMatch(html, /id="player"|id="highway"|Offline Library|offline-search/);
    assert.doesNotMatch(html, /\/static\/highway\.js|device-catalog/);
});

test('complete packages render as logical songs with count, sizes, Open, and Delete', async () => {
    const module = await loadModule();
    const document = createDocument();
    const opened = [];
    const packages = [
        metadata(REVISION_A),
        metadata(REVISION_B, { title: 'Second', artist: 'Another', filename: 'Z Second.sloppak' }),
    ];
    const controller = module.createOfflineCatalog({
        document,
        openPackageStore: async () => {},
        listPackages: async () => packages,
        openPackage: (revision) => { opened.push(revision); },
    });

    assert.equal(await controller.start(), true);
    assert.equal(document.elements.get('offline-package-manager').hidden, false);
    assert.equal(document.elements.get('offline-storage-loading').hidden, true);
    assert.equal(document.elements.get('offline-package-count').textContent, '2 songs ·');
    assert.equal(document.elements.get('offline-storage-usage').textContent, '8.0 MB downloaded');
    assert.doesNotMatch(document.elements.get('offline-storage-usage').textContent, /device storage|100 MB/);
    const rows = document.elements.get('offline-package-list').children;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].className, 'package-card');
    assert.equal(rows[0].children[1].children[0].textContent, 'Stored Song');
    assert.equal(rows[0].children[1].children[1].textContent, 'Stored Artist');
    assert.equal(rows[0].children[1].children[2].textContent, '4.0 MB');
    assert.doesNotMatch(rows[0].children[1].children[2].textContent, /arrangement/i);
    assert.equal(rows[0].children[2].children[0].getAttribute('data-offline-open'), REVISION_A);
    assert.equal(rows[0].children[2].children[1].getAttribute('data-offline-delete'), REVISION_A);

    await rows[0].children[2].children[0].dispatch('click');
    assert.deepEqual(opened, [REVISION_A]);
});

test('recovery groups decoded filenames with deterministic song, arrangement, and seed ordering', async () => {
    const module = await loadModule();
    const document = createDocument();
    const opened = [];
    const revisionC = 'c'.repeat(64);
    const revisionD = 'd'.repeat(64);
    const packages = [
        metadata(REVISION_B, { filename: 'Encoded%20Song.sloppak', arrangementIndex: 2, arrangementName: 'Bass' }),
        metadata(revisionC, { filename: 'Encoded Song.sloppak', arrangementIndex: 1, arrangementName: 'Rhythm' }),
        metadata(REVISION_A, { filename: 'Encoded Song.sloppak', arrangementIndex: 1, arrangementName: 'Rhythm alt' }),
        metadata(revisionD, { filename: 'Other.sloppak', title: 'Stored Song', artist: 'Stored Artist' }),
        metadata('e'.repeat(64), { filename: 'Encoded Song.sloppak', arrangementIndex: 0, complete: false }),
    ];
    const controller = module.createOfflineCatalog({
        document,
        openPackageStore: async () => {},
        listPackages: async () => packages,
        openPackage: async (revision) => { opened.push(revision); },
    });

    await controller.start();

    const rows = document.elements.get('offline-package-list').children;
    assert.equal(document.elements.get('offline-package-count').textContent, '2 songs ·');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].children[1].children[2].textContent, '12 MB');
    assert.equal(rows[0].children[2].children[0].getAttribute('data-offline-open'), REVISION_A);
    assert.equal(rows[1].children[2].children[0].getAttribute('data-offline-open'), revisionD);
    await rows[0].children[2].children[0].dispatch('click');
    assert.deepEqual(opened, [REVISION_A]);
});

test('recovery renders cached artwork once per song, falls back cleanly, and revokes object URLs', async () => {
    const module = await loadModule();
    const document = createDocument();
    const listeners = new Map();
    const created = [];
    const revoked = [];
    const artworkReads = [];
    const packages = [
        metadata(REVISION_B, { filename: 'Song%20One.sloppak', arrangementIndex: 1 }),
        metadata(REVISION_A, { filename: 'Song One.sloppak', arrangementIndex: 0 }),
        metadata('c'.repeat(64), { filename: 'Other.sloppak' }),
    ];
    const controller = module.createOfflineCatalog({
        document,
        window: { addEventListener: (type, listener) => listeners.set(type, listener) },
        objectUrls: {
            createObjectURL: (blob) => {
                const url = `blob:${created.length + 1}`;
                created.push([url, blob]);
                return url;
            },
            revokeObjectURL: (url) => revoked.push(url),
        },
        openPackageStore: async () => {},
        listPackages: async () => packages,
        artwork: {
            read: async (filename) => {
                artworkReads.push(filename);
                return filename === 'Song One.sloppak'
                    ? { blob: async () => ({ filename }) }
                    : null;
            },
            remove: async () => {},
        },
    });

    await controller.start();

    const cards = document.elements.get('offline-package-list').children;
    assert.equal(cards.length, 2);
    assert.deepEqual(artworkReads, ['Other.sloppak', 'Song One.sloppak']);
    assert.equal(cards[0].children[0].children[0].className, 'package-artwork-fallback');
    assert.equal(cards[1].children[0].children[0].className, 'package-artwork-image');
    assert.equal(cards[1].children[0].children[0].getAttribute('src'), 'blob:1');

    await controller.refresh();
    assert.deepEqual(revoked, ['blob:1']);
    listeners.get('beforeunload')();
    assert.deepEqual(revoked, ['blob:1', 'blob:2']);
});

test('recovery replaces artwork that fails to decode with the neutral fallback', async () => {
    const module = await loadModule();
    const document = createDocument();
    const revoked = [];
    const controller = module.createOfflineCatalog({
        document,
        objectUrls: {
            createObjectURL: () => 'blob:corrupt',
            revokeObjectURL: (url) => revoked.push(url),
        },
        openPackageStore: async () => {},
        listPackages: async () => [metadata(REVISION_A)],
        artwork: {
            read: async () => ({ blob: async () => ({ corrupt: true }) }),
            remove: async () => {},
        },
    });

    await controller.start();
    const frame = document.elements.get('offline-package-list').children[0].children[0];
    const image = frame.children[0];
    assert.equal(image.className, 'package-artwork-image');

    await image.dispatch('error');

    assert.deepEqual(revoked, ['blob:corrupt']);
    assert.equal(frame.children.length, 1);
    assert.equal(frame.children[0].className, 'package-artwork-fallback');
    assert.equal(frame.children[0].getAttribute('aria-hidden'), 'true');
});

test('Open builds an explicit one-shot offline app URL', async () => {
    const previousLocation = globalThis.location;
    const assigned = [];
    globalThis.location = { assign: (value) => { assigned.push(value); } };
    try {
        const module = await loadModule();
        const document = createDocument();
        const controller = module.createOfflineCatalog({
            document,
            openPackageStore: async () => {},
            listPackages: async () => [metadata(REVISION_A)],
        });
        await controller.start();
        await document.elements.get('offline-package-list').children[0]
            .children[2].children[0].dispatch('click');
        assert.deepEqual(assigned, [`/v3/?offline=1&revision=${REVISION_A}`]);
    } finally {
        globalThis.location = previousLocation;
    }
});

test('empty package storage shows a useful empty state', async () => {
    const module = await loadModule();
    const document = createDocument();
    const controller = module.createOfflineCatalog({
        document,
        openPackageStore: async () => {},
        listPackages: async () => [],
    });

    assert.equal(await controller.start(), true);
    assert.equal(document.elements.get('offline-package-count').textContent, '0 songs ·');
    assert.equal(document.elements.get('offline-package-empty').hidden, false);
    assert.equal(document.elements.get('offline-storage-usage').textContent, '0 B downloaded');
});

test('blocked package storage fails safely with a useful message', async () => {
    const module = await loadModule();
    const document = createDocument();
    const controller = module.createOfflineCatalog({
        document,
        openPackageStore: async () => { throw new Error('OPFS blocked'); },
        listPackages: async () => assert.fail('list should not run'),
    });

    assert.equal(await controller.start(), false);
    assert.equal(document.elements.get('offline-package-manager').hidden, false);
    assert.equal(document.elements.get('offline-package-count').textContent, 'Downloads unavailable');
    assert.equal(document.elements.get('offline-storage-error').hidden, false);
    assert.match(document.elements.get('offline-storage-error').textContent, /OPFS blocked/);
});

test('Delete requires confirmation and refreshes the package list', async () => {
    const module = await loadModule();
    const document = createDocument();
    let packages = [metadata(REVISION_A)];
    const deleted = [];
    const removedArtwork = [];
    const confirmations = [];
    const controller = module.createOfflineCatalog({
        document,
        openPackageStore: async () => {},
        listPackages: async () => packages,
        deletePackage: async (revision) => {
            deleted.push(revision);
            packages = [];
        },
        confirmDelete: (label) => { confirmations.push(label); return true; },
        artwork: {
            read: async () => null,
            remove: async (filename) => { removedArtwork.push(filename); },
        },
    });
    await controller.start();
    await document.elements.get('offline-package-list').children[0]
        .children[2].children[1].dispatch('click');

    assert.deepEqual(confirmations, ['Stored Artist - Stored Song']);
    assert.deepEqual(deleted, [REVISION_A]);
    assert.deepEqual(removedArtwork, ['Stored Song.sloppak']);
    assert.equal(document.elements.get('offline-package-count').textContent, '0 songs ·');
    assert.equal(document.elements.get('offline-package-empty').hidden, false);
});

test('group Delete removes revisions sequentially and keeps survivors visible after partial failure', async () => {
    const module = await loadModule();
    const document = createDocument();
    const first = metadata(REVISION_A, { filename: 'Song.sloppak', arrangementIndex: 0 });
    const second = metadata(REVISION_B, { filename: 'Song.sloppak', arrangementIndex: 1, arrangementName: 'Rhythm' });
    let packages = [second, first];
    const deleted = [];
    const confirmations = [];
    const removedArtwork = [];
    const controller = module.createOfflineCatalog({
        document,
        openPackageStore: async () => {},
        listPackages: async () => packages,
        deletePackage: async (revision) => {
            deleted.push(revision);
            if (revision === REVISION_B) throw new Error('delete blocked');
            packages = packages.filter((metadata) => metadata.revision !== revision);
        },
        confirmDelete: (label, count) => { confirmations.push([label, count]); return true; },
        artwork: {
            read: async () => null,
            remove: async (filename) => { removedArtwork.push(filename); },
        },
    });
    await controller.start();

    await document.elements.get('offline-package-list').children[0]
        .children[2].children[1].dispatch('click');

    assert.deepEqual(confirmations, [['Stored Artist - Stored Song', 2]]);
    assert.deepEqual(deleted, [REVISION_A, REVISION_B]);
    assert.deepEqual(removedArtwork, []);
    assert.equal(document.elements.get('offline-package-count').textContent, '1 song ·');
    assert.equal(document.elements.get('offline-package-list').children.length, 1);
    assert.equal(document.elements.get('offline-package-list').children[0]
        .children[1].children[2].textContent, '4.0 MB');
    assert.match(document.elements.get('offline-storage-error').textContent, /delete blocked/);
});

test('cancelled or failed deletion preserves the downloaded package', async () => {
    const module = await loadModule();
    for (const [label, confirmDelete, deletePackage, expectedError] of [
        ['cancelled', () => false, async () => assert.fail('delete should not run'), null],
        ['failed', () => true, async () => { throw new Error('OPFS delete failed'); }, /OPFS delete failed/],
    ]) {
        await test(label, async () => {
            const document = createDocument();
            const controller = module.createOfflineCatalog({
                document,
                openPackageStore: async () => {},
                listPackages: async () => [metadata(REVISION_A)],
                deletePackage,
                confirmDelete,
            });
            await controller.start();
            await document.elements.get('offline-package-list').children[0]
                .children[2].children[1].dispatch('click');
            assert.equal(document.elements.get('offline-package-list').children.length, 1);
            if (expectedError) {
                assert.match(document.elements.get('offline-storage-error').textContent, expectedError);
            } else {
                assert.equal(document.elements.get('offline-storage-error').hidden, true);
            }
        });
    }
});

test('recovery module depends only on device storage modules and does no network IO', () => {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.match(source, /listCompletePracticePackages/);
    assert.match(source, /deleteCompletePracticePackage/);
    assert.match(source, /readOfflineArtwork/);
    assert.match(source, /deleteOfflineArtwork/);
    assert.doesNotMatch(source, /device-catalog|offline-host|session\.js|playOfflinePracticePackage/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
});
