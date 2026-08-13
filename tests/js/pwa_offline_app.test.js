'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_PATH = path.join(ROOT, 'static', 'js', 'offline-app.js');
const APP_PATH = path.join(ROOT, 'static', 'app.js');
const PLUGIN_LOADER_PATH = path.join(ROOT, 'static', 'js', 'plugin-loader.js');
const SHELL_PATH = path.join(ROOT, 'static', 'v3', 'shell.js');
let importSerial = 0;

async function loadModule() {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    importSerial += 1;
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}#${importSerial}`);
}

test('one-shot launch intent preserves offline mode and consumes only revision', async () => {
    const module = await loadModule();
    const replacements = [];
    const history = {
        state: { keep: true },
        replaceState(...args) { replacements.push(args); },
    };
    const intent = module.consumeOfflineLaunchIntent({
        location: {
            href: `https://feedback.test/v3/?offline=1&revision=${'a'.repeat(64)}&keep=yes#/player`,
        },
        history,
    });

    assert.equal(intent.active, true);
    assert.equal(intent.revision, 'a'.repeat(64));
    assert.deepEqual(replacements, [[
        { keep: true },
        '',
        '/v3/?offline=1&keep=yes#/player',
    ]]);
});

test('refresh in offline mode has no stale launch revision to replay', async () => {
    const module = await loadModule();
    const replacements = [];
    const intent = module.consumeOfflineLaunchIntent({
        location: { href: 'https://feedback.test/v3/?offline=1' },
        history: { state: null, replaceState: (...args) => replacements.push(args) },
    });
    assert.deepEqual(intent, { active: true, revision: null });
    assert.deepEqual(replacements, []);
});

test('invalid revisions are consumed but never launched', async () => {
    const module = await loadModule();
    const replacements = [];
    const intent = module.consumeOfflineLaunchIntent({
        location: { href: 'https://feedback.test/v3/?offline=1&revision=not-safe' },
        history: { state: null, replaceState: (...args) => replacements.push(args) },
    });
    assert.equal(intent.active, true);
    assert.equal(intent.revision, null);
    assert.deepEqual(replacements, [[null, '', '/v3/?offline=1']]);
});

test('ordinary app URLs remain untouched', async () => {
    const module = await loadModule();
    const replacements = [];
    const intent = module.consumeOfflineLaunchIntent({
        location: { href: `https://feedback.test/v3/?revision=${'a'.repeat(64)}` },
        history: { state: null, replaceState: (...args) => replacements.push(args) },
    });
    assert.deepEqual(intent, { active: false, revision: null });
    assert.deepEqual(replacements, []);
});

test('offline exit replaces the app with the recovery package list', async () => {
    const module = await loadModule();
    const replaced = [];
    module.returnToOfflineRecovery({ replace: (value) => replaced.push(value) });
    assert.deepEqual(replaced, ['/static/v3/offline.html']);
});

test('offline startup suppresses server-only app and plugin polling paths', () => {
    const app = fs.readFileSync(APP_PATH, 'utf8');
    const loader = fs.readFileSync(PLUGIN_LOADER_PATH, 'utf8');
    const shell = fs.readFileSync(SHELL_PATH, 'utf8');

    assert.match(app, /if \(!offlineLaunchIntent\.active\) startDeviceCatalogCapture/);
    assert.match(loader, /bootstrapPluginsAndUi\(\{ watchStartup = true \} = \{\}\)/);
    assert.match(loader, /if \(watchStartup\) _streamPluginStartup\(\)/);
    assert.match(shell, /URLSearchParams\(location\.search\)\.get\('offline'\) === '1'[\s\S]*if \(isOfflineApp\) return;/);
});
