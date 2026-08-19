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
    ).replace(
        /import \{ playOfflinePracticePackage \} from '\.\.\/js\/session\.js';/,
        'const playOfflinePracticePackage = async () => {};',
    );
    importSerial += 1;
    return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + importSerial);
}

function metadata(revision = 'a'.repeat(64), filename = 'Song.sloppak') {
    return {
        revision,
        source: { filename },
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
            innerHTML: '',
            textContent: '',
            title: '',
            className: '',
            dataset: {},
            children: [],
            parentNode: null,
            attributes: new Map(),
            listeners: new Map(),
            lastElementChild: null,
            addEventListener(type, listener) {
                this.listeners.set(type, listener);
            },
            appendChild(child) {
                this.children.push(child);
                child.parentNode = this;
                this.lastElementChild = child;
                if (child.id) elements.set(child.id, child);
            },
            insertAdjacentHTML(_position, html) {
                const idMatch = String(html).match(/\sid="([^"]+)"/);
                const child = makeElement(idMatch ? idMatch[1] : '');
                child.innerHTML = String(html);
                this.appendChild(child);
            },
            get outerHTML() {
                return this.innerHTML;
            },
            set outerHTML(value) {
                this.innerHTML = String(value);
            },
            querySelector(selector) {
                return this.querySelectorAll(selector)[0] || null;
            },
            querySelectorAll(selector) {
                const matches = [];
                const visit = (node) => {
                    node.children.forEach((child) => {
                        if (matchesSelector(child, selector)) matches.push(child);
                        visit(child);
                    });
                };
                visit(this);
                return matches;
            },
            remove() {
                if (!this.parentNode) return;
                this.parentNode.children = this.parentNode.children.filter((child) => child !== this);
                this.parentNode.lastElementChild = this.parentNode.children[this.parentNode.children.length - 1] || null;
                this.parentNode = null;
            },
            setAttribute(name, value) {
                const stringValue = String(value);
                this.attributes.set(name, stringValue);
                if (name === 'id') {
                    this.id = stringValue;
                    elements.set(stringValue, this);
                }
            },
            getAttribute(name) {
                return this.attributes.has(name) ? this.attributes.get(name) : null;
            },
        };
        if (id) elements.set(id, element);
        return element;
    }
    function matchesSelector(element, selector) {
        if (!element) return false;
        if (selector.startsWith('.')) {
            return String(element.className || '').split(/\s+/).includes(selector.slice(1));
        }
        const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
        if (attr) {
            const value = element.getAttribute(attr[1]);
            return attr[2] === undefined ? value !== null : value === attr[2];
        }
        if (selector.startsWith('#')) return element.id === selector.slice(1);
        return false;
    }
    return {
        element: makeElement,
        getElementById: (id) => elements.get(id) || null,
        createElement: () => makeElement(),
        body: {},
    };
}

test('storage startup failure keeps the action registered and a later download retries successfully', async () => {
    const module = await loadModule();
    const document = createDocument();
    const registrations = [];
    const confirmed = [];
    const downloaded = [];
    let openCalls = 0;
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
            return metadata();
        },
        store: {
            open: async () => {
                openCalls += 1;
                if (openCalls === 1) throw new Error('OPFS unavailable');
            },
            listPackages: async () => [],
            close() {},
        },
    });

    const result = await controller.start();

    assert.equal(result.ready, false);
    assert.equal(registrations.length, 3);
    const downloadAction = registrations.find((spec) => spec.id === 'offline-download');
    const song = { provider: 'local', filename: 'Song.sloppak', title: 'Song', artist: 'Artist' };
    assert.equal(downloadAction.applies(song), true);

    await downloadAction.run(song);

    assert.equal(openCalls, 2);
    assert.equal(confirmed.length, 1);
    assert.equal(downloaded.length, 1);
});

test('persistent storage failure remains retryable and prevents download with a visible error', async () => {
    const module = await loadModule();
    const document = createDocument();
    const registrations = [];
    const notifications = [];
    let openCalls = 0;
    let confirmCalls = 0;
    let downloadCalls = 0;
    const controller = module.createOfflinePracticeController({
        document,
        window: {
            feedBack: { libraryCardActions: { register: (spec) => {
                registrations.push(spec);
                return () => {};
            } } },
            fbNotify: { show: (notice) => notifications.push(notice) },
        },
        confirm: async () => { confirmCalls += 1; return true; },
        download: async () => { downloadCalls += 1; },
        store: {
            open: async () => { openCalls += 1; throw new Error('Private storage denied'); },
            listPackages: async () => [],
            close() {},
        },
    });

    await controller.start();
    const downloadAction = registrations.find((spec) => spec.id === 'offline-download');
    await downloadAction.run({ provider: 'local', filename: 'Song.sloppak' });

    assert.equal(openCalls, 2);
    assert.equal(confirmCalls, 0);
    assert.equal(downloadCalls, 0);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].title, 'Offline storage unavailable');
    assert.equal(notifications[0].message, 'Private storage denied');
});

test('concurrent startup readiness shares one storage initialization', async () => {
    const module = await loadModule();
    const document = createDocument();
    let openCalls = 0;
    let listCalls = 0;
    let releaseOpen;
    const openGate = new Promise((resolve) => { releaseOpen = resolve; });
    const controller = module.createOfflinePracticeController({
        document,
        window: { feedBack: { libraryCardActions: { register: () => () => {} } } },
        store: {
            open: async () => { openCalls += 1; await openGate; },
            listPackages: async () => { listCalls += 1; return []; },
            close() {},
        },
    });

    const firstStart = controller.start();
    const secondStart = controller.start();
    assert.equal(openCalls, 1);
    releaseOpen();
    const results = await Promise.all([firstStart, secondStart]);

    assert.deepEqual(results.map((result) => result.ready), [true, true]);
    assert.equal(openCalls, 1);
    assert.equal(listCalls, 1);
});

test('retry synchronization prevents a stale download action from duplicating a stored package', async () => {
    const module = await loadModule();
    const document = createDocument();
    const registrations = [];
    const notifications = [];
    let openCalls = 0;
    let confirmCalls = 0;
    let downloadCalls = 0;
    const stored = metadata();
    const controller = module.createOfflinePracticeController({
        document,
        window: {
            feedBack: { libraryCardActions: { register: (spec) => {
                registrations.push(spec);
                return () => {};
            } } },
            fbNotify: { show: (notice) => notifications.push(notice) },
        },
        confirm: async () => { confirmCalls += 1; return true; },
        download: async () => { downloadCalls += 1; },
        store: {
            open: async () => {
                openCalls += 1;
                if (openCalls === 1) throw new Error('OPFS unavailable');
            },
            listPackages: async () => [stored],
            close() {},
        },
    });

    await controller.start();
    const downloadAction = registrations.find((spec) => spec.id === 'offline-download');
    const openAction = registrations.find((spec) => spec.id === 'offline-open');
    const song = { provider: 'local', filename: 'Song.sloppak' };
    assert.equal(downloadAction.applies(song), true);

    await downloadAction.run(song);

    assert.equal(confirmCalls, 0);
    assert.equal(downloadCalls, 0);
    assert.equal(downloadAction.applies(song), false);
    assert.equal(openAction.applies(song), true);
    assert.equal(notifications[0].title, 'Offline bundle already stored');
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
    assert.equal(registrations.length, 3);
    const downloadAction = registrations.find((spec) => spec.id === 'offline-download');
    assert.ok(downloadAction);
    assert.equal(downloadAction.label, 'Download for offline practice');
    assert.equal(downloadAction.applies({ provider: 'local', filename: 'Song.sloppak' }), true);
    assert.equal(downloadAction.applies({ provider: 'remote', filename: 'Song.sloppak' }), false);

    await downloadAction.run({
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

test('stored songs expose open/remove actions instead of download', async () => {
    const module = await loadModule();
    const document = createDocument();
    const registrations = [];
    const launched = [];
    const deleted = [];
    const confirmed = [];
    const toolbar = document.element('v3-songs-toolbar');
    const card = document.element();
    const badge = document.element();
    badge.textContent = 'FEEDPAK';
    badge.className = 'bg-fb-primary text-white text-[0.5625rem]';
    badge.setAttribute('data-v3-format-badge', '');
    card.setAttribute('data-fn', 'Song.sloppak');
    card.appendChild(badge);
    let storedPackages = [metadata('d'.repeat(64), 'Song.sloppak')];
    const window = {
        feedBack: {
            libraryCardActions: { register: (spec) => {
                registrations.push(spec);
                return () => {};
            } },
            on() {},
            off() {},
        },
        v3Songs: { visibleCards: () => [card] },
        fbNotify: { show() {} },
    };
    const controller = module.createOfflinePracticeController({
        document,
        window,
        confirm: async (options) => { confirmed.push(options); return true; },
        launch: async (revision) => { launched.push(revision); },
        store: {
            open: async () => {},
            listPackages: async () => storedPackages,
            deletePackage: async (revision) => {
                deleted.push(revision);
                storedPackages = [];
            },
            close() {},
        },
    });

    await controller.start();

    const button = document.getElementById('v3-songs-offline');
    const downloadAction = registrations.find((spec) => spec.id === 'offline-download');
    const openAction = registrations.find((spec) => spec.id === 'offline-open');
    const deleteAction = registrations.find((spec) => spec.id === 'offline-delete');
    const song = { provider: 'local', filename: 'Song.sloppak' };
    assert.equal(toolbar.children.includes(button), true);
    assert.equal(button.textContent, 'Offline (1)');
    assert.equal(downloadAction.applies(song), false);
    assert.equal(openAction.applies(song), true);
    assert.equal(deleteAction.applies(song), true);

    await openAction.run(song);
    assert.deepEqual(launched, ['d'.repeat(64)]);

    await deleteAction.run(song);
    assert.equal(confirmed.length, 1);
    assert.deepEqual(deleted, ['d'.repeat(64)]);
    assert.equal(button.textContent, 'Offline (0)');
    assert.equal(badge.textContent, 'FEEDPAK');
    assert.equal(downloadAction.applies(song), true);
    assert.equal(openAction.applies(song), false);
    assert.equal(deleteAction.applies(song), false);
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

test('offline status replaces and restores the visible Library card format badge', async () => {
    const module = await loadModule();
    const document = createDocument();
    const card = document.element();
    const badge = document.element();
    badge.textContent = 'FEEDPAK';
    badge.title = '';
    badge.className = 'bg-fb-primary text-white text-[0.5625rem]';
    badge.setAttribute('data-v3-format-badge', '');
    card.setAttribute('data-fn', 'Song.sloppak');
    card.appendChild(badge);
    let storedPackages = [metadata('b'.repeat(64), 'Song.sloppak')];
    const controller = module.createOfflinePracticeController({
        document,
        window: {
            feedBack: { libraryCardActions: { register: () => () => {} }, on() {}, off() {} },
            v3Songs: { visibleCards: () => [card] },
        },
        store: {
            open: async () => {},
            listPackages: async () => storedPackages,
            close() {},
        },
    });

    await controller.start();

    assert.equal(badge.textContent, 'OFFLINE');
    assert.equal(badge.title, 'Stored for offline practice');
    assert.match(badge.className, /\bbg-amber-400\b/);
    assert.match(badge.className, /\btext-black\b/);

    storedPackages = [];
    await controller.refresh();

    assert.equal(badge.textContent, 'FEEDPAK');
    assert.equal(badge.title, '');
    assert.equal(badge.className, 'bg-fb-primary text-white text-[0.5625rem]');
});

test('offline status decoration follows the Library visible-card render event', async () => {
    const module = await loadModule();
    const document = createDocument();
    const handlers = new Map();
    let visibleCards = [];
    const card = document.element();
    const badge = document.element();
    badge.textContent = 'FEEDPAK';
    badge.setAttribute('data-v3-format-badge', '');
    card.setAttribute('data-fn', 'Encoded Song.sloppak');
    card.appendChild(badge);
    const feedBack = {
        libraryCardActions: { register: () => () => {} },
        on(event, handler) { handlers.set(event, handler); },
        off(event, handler) {
            if (handlers.get(event) === handler) handlers.delete(event);
        },
    };
    const controller = module.createOfflinePracticeController({
        document,
        window: {
            feedBack,
            v3Songs: { visibleCards: () => visibleCards },
        },
        store: {
            open: async () => {},
            listPackages: async () => [metadata('c'.repeat(64), 'Encoded%20Song.sloppak')],
            close() {},
        },
    });

    await controller.start();

    assert.equal(badge.textContent, 'FEEDPAK');
    assert.equal(typeof handlers.get('v3:library-window-rendered'), 'function');

    visibleCards = [card];
    handlers.get('v3:library-window-rendered')();

    assert.equal(badge.textContent, 'OFFLINE');

    controller.destroy();
    assert.equal(handlers.has('v3:library-window-rendered'), false);
});

test('offline panel renders compact summary, quota bar, and Open action', async () => {
    const module = await loadModule();
    const document = createDocument();
    document.element('v3-songs-toolbar');
    const stored = metadata('e'.repeat(64), 'Song.sloppak');
    stored.chart.bytes = 1024 * 1024;
    stored.audio.bytes = 2 * 1024 * 1024;
    const controller = module.createOfflinePracticeController({
        document,
        window: { feedBack: { libraryCardActions: { register: () => () => {} } } },
        navigator: { storage: { estimate: async () => ({ usage: 1, quota: 1000 }) } },
        store: {
            open: async () => {},
            listPackages: async () => [stored],
            close() {},
        },
    });

    await controller.start();
    await document.getElementById('v3-songs-offline').listeners.get('click')();

    const panel = document.getElementById('v3-offline-panel');
    assert.ok(panel);
    assert.match(panel.innerHTML, /1 download · 3\.0 MiB used/);
    assert.match(panel.innerHTML, /role="meter"/);
    assert.match(panel.innerHTML, /Storage usage: 1 B used \/ 1000 B quota \(0\.1%\)/);
    assert.match(panel.innerHTML, /style="width:5\.0%"/);
    assert.match(panel.innerHTML, />Open<\/button>/);
    assert.doesNotMatch(panel.innerHTML, />Practice<\/button>/);
    assert.match(panel.innerHTML, /class="hidden sm:inline"/);
});

test('offline panel tolerates unavailable quota estimates', async () => {
    const module = await loadModule();
    const document = createDocument();
    document.element('v3-songs-toolbar');
    const controller = module.createOfflinePracticeController({
        document,
        window: { feedBack: { libraryCardActions: { register: () => () => {} } } },
        navigator: { storage: { estimate: async () => { throw new Error('quota blocked'); } } },
        store: {
            open: async () => {},
            listPackages: async () => [],
            close() {},
        },
    });

    await controller.start();
    await document.getElementById('v3-songs-offline').listeners.get('click')();

    const panel = document.getElementById('v3-offline-panel');
    assert.ok(panel);
    assert.match(panel.innerHTML, /0 downloads · 0 B used/);
    assert.match(panel.innerHTML, /No offline downloads yet/);
    assert.doesNotMatch(panel.innerHTML, /role="meter"/);
    assert.doesNotMatch(panel.innerHTML, /Unavailable/);
});

test('offline panel shows complete metadata, storage estimate, and explicit deletion', async () => {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.match(source, /Offline \(\$\{packages\.length\}\)/);
    assert.match(source, /metadata\.arrangement\.name/);
    assert.match(source, /navigatorRef\?\.storage/);
    assert.match(source, /data-offline-play/);
    assert.match(source, /await launch\(revision\)/);
    assert.match(source, /Offline launch failed/);
    assert.match(source, /data-offline-delete/);
    assert.match(source, /Delete offline bundle\?/);
    assert.match(source, /await store\.deletePackage\(revision\)/);
    assert.match(source, /await refresh\(\)/);
    assert.match(source, />Open<\/button>/);
    assert.match(source, /role="meter"/);
    assert.match(source, /hidden sm:inline/);
    assert.match(source, /v3Songs\?\.visibleCards/);
    assert.match(source, /v3:library-window-rendered/);
    assert.match(source, /data-v3-format-badge/);
    assert.doesNotMatch(source, /documentRef\.body/);
    assert.doesNotMatch(source, /subtree:\s*true/);
});
