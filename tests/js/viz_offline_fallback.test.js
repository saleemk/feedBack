'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const SOURCE_PATH = path.join(ROOT, 'static', 'js', 'viz.js');

function option(value, text) {
    return { value, text, textContent: text, nextSibling: null };
}

function createPicker({ venue = false } = {}) {
    const picker = {
        value: 'auto',
        options: [option('auto', 'Auto'), option('default', 'Classic 2D')],
        appendChild(child) { this.options.push(child); },
        removeChild(child) { this.options.splice(this.options.indexOf(child), 1); },
        insertBefore(child, sibling) {
            const index = this.options.indexOf(sibling);
            this.options.splice(index < 0 ? this.options.length : index, 0, child);
        },
    };
    if (venue) picker.options.push(option('venue', 'Venue'));
    return picker;
}

test('offline visualization fallback preserves the saved online selection', async (t) => {
    const previousGlobals = {
        document: globalThis.document,
        localStorage: globalThis.localStorage,
        window: globalThis.window,
    };
    t.after(() => {
        globalThis.document = previousGlobals.document;
        globalThis.localStorage = previousGlobals.localStorage;
        globalThis.window = previousGlobals.window;
    });
    const storage = new Map();
    const rendererCalls = [];
    const listeners = new Map();
    let picker = createPicker();

    globalThis.localStorage = {
        getItem(key) { return storage.has(key) ? storage.get(key) : null; },
        setItem(key, value) { storage.set(key, String(value)); },
        removeItem(key) { storage.delete(key); },
    };
    globalThis.document = {
        getElementById(id) {
            if (id === 'viz-picker') return picker;
            if (id === 'player') return { classList: { toggle() {} } };
            return null;
        },
        querySelector(selector) {
            if (selector === '#viz-picker option[value="auto"]') {
                return picker.options.find((entry) => entry.value === 'auto') || null;
            }
            return null;
        },
        createElement(tagName) {
            if (tagName === 'canvas') {
                return { getContext: () => ({ getExtension: () => null }) };
            }
            return option('', '');
        },
    };
    globalThis.window = {
        feedBack: {
            on(type, listener) { listeners.set(type, listener); },
            off() {},
        },
        highway: {
            getSongInfo: () => ({}),
            setRenderer(renderer) { rendererCalls.push(renderer); },
        },
    };

    const source = fs.readFileSync(SOURCE_PATH, 'utf8');
    const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

    await t.test('missing cached plugin uses built-in renderer without deleting preference', async () => {
        storage.set('vizSelection', 'highway_3d');
        picker = createPicker();
        rendererCalls.length = 0;

        await module._populateVizPicker([], { preserveSelectionOnFallback: true });

        assert.equal(storage.get('vizSelection'), 'highway_3d');
        assert.equal(picker.value, 'default');
        assert.deepEqual(rendererCalls, [null]);
    });

    await t.test('renderer fallback and later revert also preserve preference', async () => {
        storage.set('vizSelection', 'venue');
        picker = createPicker({ venue: true });
        rendererCalls.length = 0;
        const originalError = console.error;
        const originalWarn = console.warn;
        console.error = () => {};
        console.warn = () => {};
        try {
            await module._populateVizPicker([], { preserveSelectionOnFallback: true });
            listeners.get('viz:reverted')({ detail: { reason: 'offline asset missing' } });
        } finally {
            console.error = originalError;
            console.warn = originalWarn;
        }

        assert.equal(storage.get('vizSelection'), 'venue');
        assert.equal(picker.value, 'default');
        assert.deepEqual(rendererCalls, [null]);
    });

    await t.test('normal online population still cleans a stale selection', async () => {
        storage.set('vizSelection', 'removed_viz');
        picker = createPicker();
        rendererCalls.length = 0;

        await module._populateVizPicker([]);

        assert.equal(storage.get('vizSelection'), 'auto');
        assert.equal(picker.value, 'auto');
        assert.deepEqual(rendererCalls, [null]);
    });
});
