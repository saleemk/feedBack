'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', '..', 'static', 'v3', 'pwa-install.js'),
    'utf8',
);
const CSS = fs.readFileSync(
    path.join(__dirname, '..', '..', 'static', 'v3', 'v3.css'),
    'utf8',
);

class FakeClassList {
    constructor(initial = []) { this.values = new Set(initial); }
    toggle(name, force) {
        if (force === undefined) force = !this.values.has(name);
        if (force) this.values.add(name);
        else this.values.delete(name);
        return force;
    }
    contains(name) { return this.values.has(name); }
}

class FakeElement {
    constructor(hidden = false) {
        this.classList = new FakeClassList(hidden ? ['hidden'] : []);
        this.listeners = {};
        this.textContent = '';
        this.open = false;
    }
    addEventListener(type, listener) { this.listeners[type] = listener; }
    click() { if (this.listeners.click) this.listeners.click(); }
    showModal() { this.open = true; }
    close() { this.open = false; }
    setAttribute(name) { if (name === 'open') this.open = true; }
    removeAttribute(name) { if (name === 'open') this.open = false; }
}

function createHarness({ userAgent = '', platform = '', maxTouchPoints = 0,
    standalone = false, displayModeStandalone = false } = {}) {
    const elements = {
        'pwa-install-row': new FakeElement(true),
        'pwa-install-desc': new FakeElement(),
        'pwa-install-status': new FakeElement(true),
        'pwa-install-action': new FakeElement(true),
        'pwa-install-ios-dialog': new FakeElement(),
        'pwa-install-ios-close': new FakeElement(),
        'pwa-install-ios-done': new FakeElement(),
    };
    const windowListeners = {};
    const documentListeners = {};
    const navigator = { userAgent, platform, maxTouchPoints, standalone };
    const window = {
        navigator,
        matchMedia: () => ({ matches: displayModeStandalone }),
        addEventListener(type, listener) {
            (windowListeners[type] = windowListeners[type] || []).push(listener);
        },
    };
    const document = {
        readyState: 'complete',
        getElementById: (id) => elements[id] || null,
        addEventListener(type, listener) {
            (documentListeners[type] = documentListeners[type] || []).push(listener);
        },
    };
    const context = vm.createContext({ window, document, navigator, Number });
    vm.runInContext(SOURCE, context, { filename: 'pwa-install.js' });
    return {
        elements,
        window,
        emit(type, event = {}) {
            (windowListeners[type] || []).forEach((listener) => listener(event));
        },
        listenerCount(type) { return (windowListeners[type] || []).length; },
        reinject() { vm.runInContext(SOURCE, context, { filename: 'pwa-install.js' }); },
    };
}

test('Chromium action appears only with a captured prompt and consumes it once', () => {
    const harness = createHarness();
    const prompt = { calls: 0, prevented: false };
    prompt.preventDefault = () => { prompt.prevented = true; };
    prompt.prompt = () => { prompt.calls += 1; };

    assert.equal(harness.elements['pwa-install-row'].classList.contains('hidden'), true);
    harness.emit('beforeinstallprompt', prompt);

    assert.equal(prompt.prevented, true);
    assert.equal(harness.elements['pwa-install-row'].classList.contains('hidden'), false);
    assert.equal(harness.elements['pwa-install-action'].textContent, 'Install app');
    harness.elements['pwa-install-action'].click();
    harness.elements['pwa-install-action'].click();
    assert.equal(prompt.calls, 1);
    assert.equal(harness.elements['pwa-install-row'].classList.contains('hidden'), true);
});

test('installed mode suppresses actions and appinstalled refreshes without reload', () => {
    const standalone = createHarness({ displayModeStandalone: true });
    assert.equal(standalone.elements['pwa-install-status'].textContent, 'Installed');
    assert.equal(standalone.elements['pwa-install-action'].classList.contains('hidden'), true);

    const iosStandalone = createHarness({ standalone: true });
    assert.equal(iosStandalone.elements['pwa-install-status'].textContent, 'Installed');
    assert.equal(iosStandalone.elements['pwa-install-action'].classList.contains('hidden'), true);

    const browser = createHarness();
    browser.emit('beforeinstallprompt', { preventDefault() {}, prompt() {} });
    browser.emit('appinstalled');
    assert.equal(browser.elements['pwa-install-status'].textContent, 'Installed');
    assert.equal(browser.elements['pwa-install-action'].classList.contains('hidden'), true);
});

test('iPhone Safari shows steps while other iOS browsers direct users to Safari', () => {
    const safari = createHarness({
        userAgent: 'Mozilla/5.0 (iPhone) Version/18.0 Mobile/15E148 Safari/604.1',
        platform: 'iPhone',
        maxTouchPoints: 5,
    });
    assert.equal(safari.elements['pwa-install-action'].textContent, 'View steps');
    safari.elements['pwa-install-action'].click();
    assert.equal(safari.elements['pwa-install-ios-dialog'].open, true);

    const ipad = createHarness({
        userAgent: 'Mozilla/5.0 (Macintosh) Version/18.0 Mobile/15E148 Safari/604.1',
        platform: 'MacIntel',
        maxTouchPoints: 5,
    });
    assert.equal(ipad.elements['pwa-install-action'].textContent, 'View steps');

    const chrome = createHarness({
        userAgent: 'Mozilla/5.0 (iPhone) CriOS/130.0 Mobile/15E148 Safari/604.1',
        platform: 'iPhone',
        maxTouchPoints: 5,
    });
    assert.match(chrome.elements['pwa-install-desc'].textContent, /Open fee\[dB\]ack in Safari/);
    assert.equal(chrome.elements['pwa-install-action'].classList.contains('hidden'), true);
});

test('unsupported browsers stay quiet and reinjection does not duplicate listeners', () => {
    const harness = createHarness();
    assert.equal(harness.elements['pwa-install-row'].classList.contains('hidden'), true);
    assert.equal(harness.listenerCount('beforeinstallprompt'), 1);
    assert.equal(harness.listenerCount('appinstalled'), 1);
    harness.reinject();
    assert.equal(harness.listenerCount('beforeinstallprompt'), 1);
    assert.equal(harness.listenerCount('appinstalled'), 1);
});

test('the initial hidden state wins over the Settings row display rule', () => {
    assert.match(CSS, /#pwa-install-row\.hidden\s*\{\s*display:\s*none;\s*\}/);
});
