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
    const source = fs.readFileSync(MODULE_PATH, 'utf8')
        .replace('../js/practice-package-store.js', storeUrl);
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

function metadata(revision, { title = 'Stored Song', artist = 'Stored Artist' } = {}) {
    return {
        revision,
        source: { filename: `${title}.sloppak` },
        song: { title, artist },
        arrangement: { name: 'Lead' },
        chart: { bytes: 1024 },
        audio: { bytes: 4 * 1024 * 1024 },
    };
}

test('recovery document is package-only and Retry remains independent', () => {
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    assert.match(html, /Downloaded practice/);
    assert.match(html, /id="offline-package-list"/);
    assert.match(html, /id="offline-storage-usage"/);
    assert.match(html, /window\.location\.assign\('\/v3\/'\)/);
    assert.doesNotMatch(html, /id="player"|id="highway"|Offline Library|offline-search/);
    assert.doesNotMatch(html, /\/static\/highway\.js|device-catalog/);
});

test('complete packages render with count, sizes, Open, and Delete', async () => {
    const module = await loadModule();
    const document = createDocument();
    const opened = [];
    const packages = [
        metadata(REVISION_A),
        metadata(REVISION_B, { title: 'Second', artist: 'Another' }),
    ];
    const controller = module.createOfflineCatalog({
        document,
        openPackageStore: async () => {},
        listPackages: async () => packages,
        openPackage: (revision) => { opened.push(revision); },
        estimateStorage: async () => ({ usage: 20 * 1024 * 1024, quota: 100 * 1024 * 1024 }),
    });

    assert.equal(await controller.start(), true);
    assert.equal(document.elements.get('offline-package-manager').hidden, false);
    assert.equal(document.elements.get('offline-storage-loading').hidden, true);
    assert.equal(document.elements.get('offline-package-count').textContent, '2 downloads');
    assert.match(document.elements.get('offline-storage-usage').textContent, /8\.0 MB downloaded/);
    assert.match(document.elements.get('offline-storage-usage').textContent, /20 MB of 100 MB device storage used/);
    const rows = document.elements.get('offline-package-list').children;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].children[0].children[0].textContent, 'Stored Artist - Stored Song');
    assert.match(rows[0].children[0].children[1].textContent, /Lead · 4\.0 MB/);
    assert.equal(rows[0].children[1].children[0].getAttribute('data-offline-open'), REVISION_A);
    assert.equal(rows[0].children[1].children[1].getAttribute('data-offline-delete'), REVISION_A);

    await rows[0].children[1].children[0].dispatch('click');
    assert.deepEqual(opened, [REVISION_A]);
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
            estimateStorage: async () => null,
        });
        await controller.start();
        await document.elements.get('offline-package-list').children[0]
            .children[1].children[0].dispatch('click');
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
        estimateStorage: async () => null,
    });

    assert.equal(await controller.start(), true);
    assert.equal(document.elements.get('offline-package-count').textContent, '0 downloads');
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
        estimateStorage: async () => null,
    });
    await controller.start();
    await document.elements.get('offline-package-list').children[0]
        .children[1].children[1].dispatch('click');

    assert.deepEqual(confirmations, ['Stored Artist - Stored Song']);
    assert.deepEqual(deleted, [REVISION_A]);
    assert.equal(document.elements.get('offline-package-count').textContent, '0 downloads');
    assert.equal(document.elements.get('offline-package-empty').hidden, false);
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
                estimateStorage: async () => null,
            });
            await controller.start();
            await document.elements.get('offline-package-list').children[0]
                .children[1].children[1].dispatch('click');
            assert.equal(document.elements.get('offline-package-list').children.length, 1);
            if (expectedError) {
                assert.match(document.elements.get('offline-storage-error').textContent, expectedError);
            } else {
                assert.equal(document.elements.get('offline-storage-error').hidden, true);
            }
        });
    }
});

test('recovery module depends only on the package store and does no network IO', () => {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.match(source, /listCompletePracticePackages/);
    assert.match(source, /deleteCompletePracticePackage/);
    assert.doesNotMatch(source, /device-catalog|offline-host|session\.js|playOfflinePracticePackage/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
});
