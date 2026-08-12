'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_PATH = path.join(ROOT, 'static', 'v3', 'offline-practice.js');
let importSerial = 0;

async function loadModule() {
    const source = fs.readFileSync(MODULE_PATH, 'utf8').replace(
        /import \{[\s\S]*?\} from '\.\.\/js\/practice-package-store\.js';/,
        'const closePracticePackageStore = () => {};\n'
            + 'const deleteCompletePracticePackage = async () => {};\n'
            + 'const listCompletePracticePackages = async () => [];\n'
            + 'const openPracticePackageStore = async () => {};',
    ).replace(
        /import \{ downloadPracticePackage \} from '\.\.\/js\/practice-package-client\.js';/,
        'const downloadPracticePackage = async () => {};',
    );
    importSerial += 1;
    return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + importSerial);
}

function metadata(revision = 'a'.repeat(64)) {
    return {
        revision,
        song: { artist: 'Artist', title: 'Song', duration: 42.5 },
        arrangement: { name: 'Lead' },
        chart: { bytes: 10 },
        audio: { bytes: 20 },
        storedAt: 1700000000000,
    };
}

function createDocument() {
    const elements = new Map();
    function makeElement(id = '') {
        const element = {
            id,
            textContent: '',
            children: [],
            attributes: new Map(),
            listeners: new Map(),
            lastElementChild: null,
            addEventListener(type, listener) {
                this.listeners.set(type, listener);
            },
            appendChild(child) {
                this.children.push(child);
                this.lastElementChild = child;
                if (child.id) elements.set(child.id, child);
            },
            insertAdjacentHTML() {},
            querySelector: () => null,
            querySelectorAll: () => [],
            remove() {},
            setAttribute(name, value) {
                this.attributes.set(name, value);
            },
            getAttribute(name) {
                return this.attributes.get(name) || null;
            },
        };
        if (id) elements.set(id, element);
        return element;
    }
    return {
        element: makeElement,
        getElementById: (id) => elements.get(id) || null,
        createElement: () => makeElement(),
        body: {},
    };
}

test('storage failure leaves the offline action unregistered', async () => {
    const module = await loadModule();
    const document = createDocument();
    const registrations = [];
    const window = {
        feedBack: { libraryCardActions: { register: (spec) => { registrations.push(spec); } } },
    };
    const controller = module.createOfflinePracticeController({
        document,
        window,
        store: { open: async () => { throw new Error('OPFS unavailable'); } },
    });

    const result = await controller.start();

    assert.equal(result.ready, false);
    assert.equal(registrations.length, 0);
});

test('ready storage registers the menu action and confirms before downloading', async () => {
    const module = await loadModule();
    const document = createDocument();
    const registrations = [];
    const confirmed = [];
    const downloaded = [];
    const stored = metadata();
    const window = {
        feedBack: { libraryCardActions: { register: (spec) => {
            registrations.push(spec);
            return () => {};
        } } },
        fbNotify: { show() {} },
    };
    const controller = module.createOfflinePracticeController({
        document,
        window,
        location: { href: 'https://feedback.test/' },
        confirm: async (options) => { confirmed.push(options); return true; },
        download: async (options) => {
            downloaded.push(options);
            return stored;
        },
        store: {
            open: async () => {},
            listPackages: async () => [],
            close() {},
        },
    });

    const result = await controller.start();
    assert.equal(result.ready, true);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0].label, 'Download for offline practice');
    assert.equal(registrations[0].applies({ provider: 'local', filename: 'Song.sloppak' }), true);
    assert.equal(registrations[0].applies({ provider: 'remote', filename: 'Song.sloppak' }), false);

    await registrations[0].run({
        provider: 'local',
        filename: 'Song.sloppak',
        title: 'Song',
        artist: 'Artist',
    });

    assert.equal(confirmed.length, 1);
    assert.match(confirmed[0].html, /full mix/);
    assert.match(confirmed[0].html, /default chart/);
    assert.equal(downloaded.length, 1);
    assert.equal(downloaded[0].filename, 'Song.sloppak');
});

test('offline toolbar control is bound from the Library root observer', async () => {
    const previousMutationObserver = globalThis.MutationObserver;
    const observed = [];
    globalThis.MutationObserver = class {
        constructor(callback) {
            this.callback = callback;
        }

        observe(target, options) {
            observed.push({ target, options, trigger: this.callback });
        }

        disconnect() {}
    };

    try {
        const module = await loadModule();
        const document = createDocument();
        const root = document.element('v3-songs');
        const controller = module.createOfflinePracticeController({
            document,
            window: { feedBack: { libraryCardActions: { register: () => () => {} } } },
            store: {
                open: async () => {},
                listPackages: async () => [metadata()],
                close() {},
            },
        });

        await controller.start();

        assert.equal(observed.length, 1);
        assert.equal(observed[0].target, root);
        assert.deepEqual(observed[0].options, { childList: true });
        assert.equal(document.getElementById('v3-songs-offline'), null);

        const toolbar = document.element('v3-songs-toolbar');
        const wrapper = document.element();
        const controls = document.element();
        wrapper.appendChild(controls);
        toolbar.appendChild(wrapper);
        root.appendChild(toolbar);
        observed[0].trigger();

        const button = document.getElementById('v3-songs-offline');
        assert.ok(button);
        assert.equal(button.textContent, 'Offline (1)');
        assert.equal(button.getAttribute('aria-expanded'), 'false');
        assert.equal(controls.children.includes(button), true);
    } finally {
        globalThis.MutationObserver = previousMutationObserver;
    }
});

test('offline panel shows complete metadata, storage estimate, and explicit deletion', async () => {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.match(source, /Offline \(\$\{packages\.length\}\)/);
    assert.match(source, /metadata\.arrangement\.name/);
    assert.match(source, /navigatorRef\?\.storage/);
    assert.match(source, /data-offline-delete/);
    assert.match(source, /Delete offline bundle\?/);
    assert.match(source, /await store\.deletePackage\(revision\)/);
    assert.match(source, /await refresh\(\)/);
    assert.doesNotMatch(source, /documentRef\.body/);
    assert.doesNotMatch(source, /subtree:\s*true/);
});
