'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.join(
    __dirname,
    '..',
    '..',
    'static',
    'js',
    'app-availability.js',
);
let importSerial = 0;

async function loadModule() {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    const encoded = Buffer.from(source).toString('base64');
    importSerial += 1;
    return import(`data:text/javascript;base64,${encoded}#${importSerial}`);
}

function inertTimeouts() {
    const cancelled = [];
    return {
        cancelled,
        scheduleTimeout: () => Symbol('timeout'),
        cancelTimeout: (token) => cancelled.push(token),
    };
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

test('availability follows cached-shell, online, unavailable, and recovery transitions', async () => {
    const module = await loadModule();
    const timeouts = inertTimeouts();
    const requests = [];
    const outcomes = [
        { ok: false },
        { ok: false },
        { ok: true },
        new TypeError('network failed'),
        { ok: true },
    ];
    const availability = module.createAppAvailability({
        fetch: async (url, options) => {
            requests.push({ url, options });
            const outcome = outcomes.shift();
            if (outcome instanceof Error) throw outcome;
            return outcome;
        },
        ...timeouts,
    });
    const transitions = [];
    availability.subscribe(({ state }) => transitions.push(state));

    assert.deepEqual(availability.snapshot(), { state: 'checking' });
    assert.deepEqual(await availability.check(), { state: 'cached-shell' });
    assert.deepEqual(await availability.check(), { state: 'cached-shell' });
    assert.deepEqual(await availability.check(), { state: 'online' });
    assert.deepEqual(await availability.check(), { state: 'server-unavailable' });
    assert.deepEqual(await availability.check(), { state: 'online' });

    assert.deepEqual(transitions, [
        'cached-shell',
        'online',
        'server-unavailable',
        'online',
    ]);
    assert.equal(requests.length, 5);
    assert.equal(requests[0].url, '/api/version');
    assert.equal(requests[0].options.method, 'GET');
    assert.equal(requests[0].options.cache, 'no-store');
    assert.equal(requests[0].options.credentials, 'same-origin');
    assert.ok(requests[0].options.signal);
    assert.equal(timeouts.cancelled.length, 5);
});

test('a timeout aborts the request, resolves as failed, and clears its timer', async () => {
    const module = await loadModule();
    const controllers = [];
    let timeoutCallback;
    let cancelledToken;
    class FakeAbortController {
        constructor() {
            this.signal = {};
            this.aborted = false;
            controllers.push(this);
        }
        abort() { this.aborted = true; }
    }
    const availability = module.createAppAvailability({
        fetch: () => new Promise(() => {}),
        timeoutMs: 25,
        AbortController: FakeAbortController,
        scheduleTimeout(callback, delay) {
            assert.equal(delay, 25);
            timeoutCallback = callback;
            return 17;
        },
        cancelTimeout(token) { cancelledToken = token; },
    });

    const checking = availability.check();
    timeoutCallback();
    assert.deepEqual(await checking, { state: 'cached-shell' });
    assert.equal(controllers[0].aborted, true);
    assert.equal(cancelledToken, 17);
});

test('concurrent checks coalesce one active probe', async () => {
    const module = await loadModule();
    const response = deferred();
    const timeouts = inertTimeouts();
    let fetchCalls = 0;
    const availability = module.createAppAvailability({
        fetch: () => {
            fetchCalls += 1;
            return response.promise;
        },
        ...timeouts,
    });

    const first = availability.check();
    const second = availability.check();
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(fetchCalls, 1);

    response.resolve({ ok: true });
    assert.deepEqual(await first, { state: 'online' });
});

test('subscriptions are idempotent, isolated, removable, and receive frozen snapshots', async () => {
    const module = await loadModule();
    const timeouts = inertTimeouts();
    const outcomes = [{ ok: true }, { ok: false }];
    const availability = module.createAppAvailability({
        fetch: async () => outcomes.shift(),
        ...timeouts,
    });
    const updates = [];
    const listener = (snapshot) => updates.push(snapshot);
    const unsubscribe = availability.subscribe(listener);
    availability.subscribe(listener);
    availability.subscribe(() => { throw new Error('listener failed'); });

    const initial = availability.snapshot();
    assert.equal(Object.isFrozen(initial), true);
    assert.throws(() => { initial.state = 'online'; }, TypeError);

    await availability.check();
    assert.equal(updates.length, 1);
    assert.equal(Object.isFrozen(updates[0]), true);
    assert.deepEqual(updates[0], { state: 'online' });

    assert.equal(unsubscribe(), true);
    assert.equal(unsubscribe(), false);
    await availability.check();
    assert.equal(updates.length, 1);
    assert.deepEqual(availability.snapshot(), { state: 'server-unavailable' });
});
