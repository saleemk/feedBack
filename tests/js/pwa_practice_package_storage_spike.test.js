'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_PATH = path.join(
    ROOT, 'static', 'v3', 'practice-package-storage-spike.js',
);
let importSerial = 0;

async function loadModule() {
    const source = fs.readFileSync(MODULE_PATH, 'utf8').replace(
        /import \{[\s\S]*?\} from '\.\.\/js\/practice-package-store\.js';/,
        `const closePracticePackageStore = () => {};
const deleteCompletePracticePackage = () => {};
const listCompletePracticePackages = () => {};
const openPracticePackageStore = () => {};
const readCompletePracticePackage = () => {};
const saveCompletePracticePackage = () => {};
const validatePracticePackageManifest = (manifest) => ({
    chartUrl: manifest.chart.url,
    audioUrl: manifest.audio.url,
});`,
    );
    const encoded = Buffer.from(source).toString('base64');
    importSerial += 1;
    return import(`data:text/javascript;base64,${encoded}#${importSerial}`);
}

class FakeEventTarget {
    constructor() {
        this.listeners = new Map();
    }

    addEventListener(type, listener, options = {}) {
        const listeners = this.listeners.get(type) || [];
        listeners.push({ listener, once: options.once === true });
        this.listeners.set(type, listeners);
    }

    async dispatch(type) {
        const listeners = (this.listeners.get(type) || []).slice();
        for (const entry of listeners) {
            await entry.listener({ type, target: this });
            if (entry.once) {
                const current = this.listeners.get(type) || [];
                this.listeners.set(type, current.filter((item) => item !== entry));
            }
        }
    }
}

class FakeElement extends FakeEventTarget {
    constructor(id = '') {
        super();
        this.id = id;
        this.value = '';
        this.textContent = '';
        this.dataset = {};
        this.disabled = false;
        this.children = [];
        this.duration = Number.NaN;
        this.currentTime = 0;
        this.pauseCalls = 0;
        this.loadCalls = 0;
    }

    replaceChildren() {
        this.children = [];
        this.value = '';
    }

    append(child) {
        this.children.push(child);
        if (!this.value) this.value = child.value;
    }

    pause() {
        this.pauseCalls += 1;
    }

    load() {
        this.loadCalls += 1;
    }

    removeAttribute(name) {
        delete this[name];
    }

    async play() {}
}

function createMockAudioContext({
    buffer = {
        duration: 245.803,
        sampleRate: 44100,
        numberOfChannels: 2,
        length: 108397122,
    },
    decodeError = null,
} = {}) {
    const contexts = [];

    class MockAudioContext {
        constructor() {
            this.currentTime = 0;
            this.destination = {};
            this.resumeCalls = 0;
            this.closeCalls = 0;
            this.decodeCalls = [];
            this.sources = [];
            contexts.push(this);
        }

        async resume() {
            this.resumeCalls += 1;
        }

        async close() {
            this.closeCalls += 1;
        }

        async decodeAudioData(value) {
            this.decodeCalls.push(value);
            if (decodeError) throw decodeError;
            return buffer;
        }

        createBufferSource() {
            const source = {
                startCalls: [],
                stopCalls: 0,
                disconnectCalls: 0,
                connect(destination) { this.destination = destination; },
                disconnect() { this.disconnectCalls += 1; },
                start(...args) { this.startCalls.push(args); },
                stop() { this.stopCalls += 1; },
            };
            this.sources.push(source);
            return source;
        }
    }

    return { AudioContext: MockAudioContext, contexts };
}

function metadata(revision, title) {
    return {
        revision,
        song: { artist: 'Artist', title, duration: 245.803 },
        arrangement: { name: 'Lead' },
        chart: { bytes: 10 },
        audio: { bytes: 20 },
    };
}

async function createControllerFixture(module, packages, {
    readError = null,
    readPackage = null,
    fetch = globalThis.fetch,
    savePackage = async () => {},
    deletePackage = async () => {},
    AudioContext = undefined,
} = {}) {
    const elements = new Map();
    const element = (id) => {
        if (!elements.has(id)) elements.set(id, new FakeElement(id));
        return elements.get(id);
    };
    const commandIds = [
        'request-persistence',
        'refresh-estimate',
        'download-package',
        'reopen-package',
        'play-audio',
        'decode-stored-audio',
        'play-decoded-audio',
        'delete-package',
    ];
    const document = {
        getElementById: element,
        createElement: () => new FakeElement(),
        querySelectorAll: (selector) => (
            selector === 'button[data-command]' ? commandIds.map(element) : []
        ),
    };
    const eventTarget = new FakeEventTarget();
    const revokedUrls = [];
    let objectUrlCount = 0;
    let closeCalls = 0;
    const store = {
        open: async () => {},
        listPackages: async () => packages,
        readPackage: async (revision) => {
            if (readError) throw readError;
            if (readPackage) return readPackage(revision);
            return {
                metadata: packages.find((entry) => entry.revision === revision),
                chart: new Blob(['chart'], { type: 'application/x-ndjson' }),
                audio: new Blob(['audio'], { type: 'audio/ogg' }),
            };
        },
        savePackage,
        deletePackage,
        close: () => { closeCalls += 1; },
    };
    class HarnessURL extends URL {}
    HarnessURL.createObjectURL = () => `blob:stored-${++objectUrlCount}`;
    HarnessURL.revokeObjectURL = (url) => revokedUrls.push(url);
    const controller = module.createPracticePackageStorageSpike({
        document,
        navigator: {},
        location: { href: 'https://feedback.test/harness', origin: 'https://feedback.test' },
        fetch,
        eventTarget,
        URL: HarnessURL,
        AudioContext,
        store,
    });
    await controller.start();
    return {
        controller,
        element,
        eventTarget,
        revokedUrls,
        get closeCalls() { return closeCalls; },
    };
}

test('manifest URL construction preserves and encodes all selection parameters', async () => {
    const module = await loadModule();
    const pathAndQuery = module.buildPracticeManifestUrl({
        filename: 'Artist/Song & Mix.sloppak',
        arrangement: 2,
        namingMode: 'smart',
        drumPart: 'live/kit & room',
    }, 'https://feedback.test/static/v3/practice-package-storage-spike.html');
    const url = new URL(pathAndQuery, 'https://feedback.test');

    assert.equal(url.pathname, '/api/practice-package/manifest');
    assert.equal(url.searchParams.get('filename'), 'Artist/Song & Mix.sloppak');
    assert.equal(url.searchParams.get('arrangement'), '2');
    assert.equal(url.searchParams.get('naming_mode'), 'smart');
    assert.equal(url.searchParams.get('drum_part'), 'live/kit & room');
    assert.match(pathAndQuery, /filename=Artist%2FSong\+%26\+Mix\.sloppak/);
    assert.match(pathAndQuery, /drum_part=live%2Fkit\+%26\+room/);
});

test('compatibility harness remains unlinked and outside service-worker caches', () => {
    const index = fs.readFileSync(path.join(ROOT, 'static', 'v3', 'index.html'), 'utf8');
    const worker = fs.readFileSync(
        path.join(ROOT, 'static', 'v3', 'service-worker.js'),
        'utf8',
    );
    const shellManifest = fs.readFileSync(
        path.join(ROOT, 'static', 'v3', 'pwa-shell-assets.json'),
        'utf8',
    );
    const harness = fs.readFileSync(
        path.join(ROOT, 'static', 'v3', 'practice-package-storage-spike.html'),
        'utf8',
    );
    const needle = 'practice-package-storage-spike';

    assert.equal(index.includes(needle), false);
    assert.equal(worker.includes(needle), false);
    assert.equal(shellManifest.includes(needle), false);
    assert.equal(harness.includes('Stored OPFS File playback'), true);
    assert.equal(harness.includes('Stored Blob playback'), false);
});

test('download forwards response streams without materializing response Blobs', async () => {
    const module = await loadModule();
    const revision = 'a'.repeat(64);
    const stored = metadata(revision, 'Alpha');
    const chartStream = { pipeTo() {} };
    const audioStream = { pipeTo() {} };
    const manifest = {
        chart: { url: '/api/practice-package/chart?filename=encoded' },
        audio: { url: '/api/sloppak/song/file/full.ogg' },
    };
    const responses = [
        { ok: true, json: async () => manifest },
        {
            ok: true,
            body: chartStream,
            headers: { get: () => 'application/x-ndjson; charset=utf-8' },
            blob: () => { throw new Error('chart response must not become a Blob'); },
        },
        {
            ok: true,
            body: audioStream,
            headers: { get: () => 'audio/ogg' },
            blob: () => { throw new Error('audio response must not become a Blob'); },
        },
    ];
    const fetchCalls = [];
    const fetch = async (url) => {
        fetchCalls.push(url);
        return responses.shift();
    };
    let savedArtifacts = null;
    const fixture = await createControllerFixture(module, [stored], {
        fetch,
        savePackage: async (_manifest, artifacts) => {
            savedArtifacts = artifacts;
            return stored;
        },
    });

    await fixture.element('download-package').dispatch('click');

    assert.equal(fetchCalls.length, 3);
    assert.equal(savedArtifacts.chart.stream, chartStream);
    assert.equal(savedArtifacts.audio.stream, audioStream);
    assert.equal(savedArtifacts.chart.mediaType, 'application/x-ndjson; charset=utf-8');
    assert.equal(savedArtifacts.audio.mediaType, 'audio/ogg');
});

test('download cancels a fetched stream when its sibling fails', async () => {
    const module = await loadModule();
    const fetchError = new Error('Audio connection failed');
    let chartCancelCalls = 0;
    const chartStream = {
        pipeTo() {},
        cancel: async () => {
            chartCancelCalls += 1;
            throw new Error('Chart cancellation failed');
        },
    };
    const manifest = {
        chart: { url: '/api/practice-package/chart?filename=encoded' },
        audio: { url: '/api/sloppak/song/file/full.ogg' },
    };
    const responses = [
        { ok: true, json: async () => manifest },
        {
            ok: true,
            body: chartStream,
            headers: { get: () => 'application/x-ndjson' },
        },
    ];
    const fetch = async () => {
        if (responses.length > 0) return responses.shift();
        throw fetchError;
    };
    let saveCalls = 0;
    const fixture = await createControllerFixture(module, [], {
        fetch,
        savePackage: async () => { saveCalls += 1; },
    });

    await fixture.element('download-package').dispatch('click');

    assert.equal(chartCancelCalls, 1);
    assert.equal(saveCalls, 0);
    assert.equal(fixture.element('operation-result').textContent, fetchError.message);
    assert.equal(fixture.element('operation-result').dataset.state, 'error');
});

test('stored audio is not decoded before an explicit decode command', async () => {
    const module = await loadModule();
    const revision = 'a'.repeat(64);
    const audio = {
        arrayBufferCalls: 0,
        async arrayBuffer() {
            this.arrayBufferCalls += 1;
            return new ArrayBuffer(8);
        },
    };
    const webAudio = createMockAudioContext();
    const fixture = await createControllerFixture(module, [metadata(revision, 'Alpha')], {
        AudioContext: webAudio.AudioContext,
        readPackage: async () => ({
            metadata: metadata(revision, 'Alpha'),
            chart: new Blob(['chart']),
            audio,
        }),
    });

    await fixture.element('reopen-package').dispatch('click');

    assert.equal(audio.arrayBufferCalls, 0);
    assert.equal(webAudio.contexts.length, 0);
    assert.equal(fixture.element('decoded-status').textContent, 'No decoded audio');
});

test('decoded playback uses the requested offset and replaces an existing source', async () => {
    const module = await loadModule();
    const revision = 'a'.repeat(64);
    const webAudio = createMockAudioContext();
    const fixture = await createControllerFixture(module, [metadata(revision, 'Alpha')], {
        AudioContext: webAudio.AudioContext,
    });

    await fixture.element('reopen-package').dispatch('click');
    await fixture.element('decode-stored-audio').dispatch('click');

    const context = webAudio.contexts[0];
    assert.equal(context.decodeCalls.length, 1);
    assert.equal(fixture.element('decoded-duration').textContent, '245.80 s');
    assert.equal(fixture.element('decoded-manifest-duration').textContent, '245.80 s');
    assert.equal(fixture.element('decoded-duration-difference').textContent, '+0.00 s');

    fixture.element('seek-seconds').value = '40';
    await fixture.element('play-decoded-audio').dispatch('click');
    const firstSource = context.sources[0];
    assert.deepEqual(firstSource.startCalls, [[0, 40]]);

    context.currentTime = 41;
    fixture.element('seek-seconds').value = '240';
    await fixture.element('play-decoded-audio').dispatch('click');
    const secondSource = context.sources[1];
    assert.equal(firstSource.stopCalls, 1);
    assert.equal(firstSource.disconnectCalls, 1);
    assert.deepEqual(secondSource.startCalls, [[0, 240]]);

    secondSource.onended();
    assert.match(fixture.element('decoded-playback-status').textContent, /Ended naturally/);

    fixture.element('seek-seconds').value = '40';
    await fixture.element('play-decoded-audio').dispatch('click');
    const thirdSource = context.sources[2];
    fixture.element('seek-seconds').value = '999';
    await fixture.element('play-decoded-audio').dispatch('click');
    assert.equal(thirdSource.stopCalls, 1);
    assert.equal(context.sources.length, 3);
    assert.match(
        fixture.element('decoded-playback-status').textContent,
        /Current 245\.80 s \| Requested offset is at decoded end/,
    );
});

test('Web Audio probe reports unavailable and decode failures concisely', async (t) => {
    const module = await loadModule();
    const revision = 'a'.repeat(64);

    await t.test('unavailable', async () => {
        const fixture = await createControllerFixture(module, [metadata(revision, 'Alpha')]);
        await fixture.element('reopen-package').dispatch('click');
        await fixture.element('decode-stored-audio').dispatch('click');

        assert.equal(fixture.element('operation-result').textContent, 'Web Audio is unavailable');
        assert.equal(fixture.element('operation-result').dataset.state, 'error');
    });

    await t.test('decode failure', async () => {
        const webAudio = createMockAudioContext({ decodeError: new Error('Decoder rejected OGG') });
        const fixture = await createControllerFixture(module, [metadata(revision, 'Alpha')], {
            AudioContext: webAudio.AudioContext,
        });
        await fixture.element('reopen-package').dispatch('click');
        await fixture.element('decode-stored-audio').dispatch('click');

        assert.equal(
            fixture.element('operation-result').textContent,
            'Unable to decode stored audio (Error: Decoder rejected OGG)',
        );
        assert.equal(fixture.element('operation-result').dataset.state, 'error');
    });
});

test('pagehide stops decoded playback, releases the buffer, and closes the owned context', async () => {
    const module = await loadModule();
    const revision = 'a'.repeat(64);
    const webAudio = createMockAudioContext();
    const fixture = await createControllerFixture(module, [metadata(revision, 'Alpha')], {
        AudioContext: webAudio.AudioContext,
    });

    await fixture.element('reopen-package').dispatch('click');
    await fixture.element('decode-stored-audio').dispatch('click');
    await fixture.element('play-decoded-audio').dispatch('click');
    const firstContext = webAudio.contexts[0];
    const source = firstContext.sources[0];

    await fixture.eventTarget.dispatch('pagehide');

    assert.equal(source.stopCalls, 1);
    assert.equal(source.disconnectCalls, 1);
    assert.equal(firstContext.closeCalls, 1);
    await fixture.element('play-decoded-audio').dispatch('click');
    assert.equal(fixture.element('operation-result').textContent, 'Decode stored audio first');

    await fixture.element('reopen-package').dispatch('click');
    await fixture.element('decode-stored-audio').dispatch('click');
    assert.equal(webAudio.contexts.length, 2);
});

test('changing the selected package releases audio opened for another revision', async () => {
    const module = await loadModule();
    const revisionA = 'a'.repeat(64);
    const revisionB = 'b'.repeat(64);
    const fixture = await createControllerFixture(module, [
        metadata(revisionA, 'Alpha'),
        metadata(revisionB, 'Beta'),
    ]);
    const select = fixture.element('stored-package');
    const audio = fixture.element('stored-audio');

    await fixture.element('reopen-package').dispatch('click');
    assert.equal(audio.src, 'blob:stored-1');
    assert.equal(fixture.element('package-revision').textContent, revisionA);
    assert.match(fixture.element('media-status').textContent, /Stored OPFS File open/);

    select.value = revisionB;
    await select.dispatch('change');

    assert.equal(audio.src, undefined);
    assert.deepEqual(fixture.revokedUrls, ['blob:stored-1']);
    assert.equal(fixture.element('package-revision').textContent, revisionB);
    assert.match(fixture.element('media-status').textContent, /No package open/);
});

test('every pagehide cleans up a newly reopened object URL and database handle', async () => {
    const module = await loadModule();
    const revision = 'a'.repeat(64);
    const fixture = await createControllerFixture(module, [metadata(revision, 'Alpha')]);

    await fixture.element('reopen-package').dispatch('click');
    await fixture.eventTarget.dispatch('pagehide');
    await fixture.element('reopen-package').dispatch('click');
    await fixture.eventTarget.dispatch('pagehide');

    assert.deepEqual(fixture.revokedUrls, ['blob:stored-1', 'blob:stored-2']);
    assert.equal(fixture.closeCalls, 2);
});

test('metadata-first delete cleanup failure still removes stale selection and audio', async () => {
    const module = await loadModule();
    const revision = 'a'.repeat(64);
    const packages = [metadata(revision, 'Alpha')];
    const cause = new DOMException('Revision directory is busy', 'InvalidStateError');
    const error = new Error('Unable to delete practice-package artifacts', { cause });
    const fixture = await createControllerFixture(module, packages, {
        deletePackage: async () => {
            packages.splice(0);
            throw error;
        },
    });

    await fixture.element('reopen-package').dispatch('click');
    await fixture.element('delete-package').dispatch('click');

    assert.deepEqual(fixture.revokedUrls, ['blob:stored-1']);
    assert.equal(fixture.element('stored-package').disabled, true);
    assert.equal(
        fixture.element('operation-result').textContent,
        'Unable to delete practice-package artifacts '
            + '(InvalidStateError: Revision directory is busy)',
    );
});

test('storage errors show one bounded cause while cause-free messages stay unchanged', async (t) => {
    const module = await loadModule();
    const revision = 'a'.repeat(64);
    const stored = [metadata(revision, 'Alpha')];

    await t.test('request cause', async () => {
        const cause = new DOMException('Blob value could not be cloned', 'DataCloneError');
        const error = new Error('Practice-package transaction was aborted', { cause });
        const fixture = await createControllerFixture(module, stored, { readError: error });

        await fixture.element('reopen-package').dispatch('click');

        assert.equal(
            fixture.element('operation-result').textContent,
            'Practice-package transaction was aborted '
                + '(DataCloneError: Blob value could not be cloned)',
        );
        assert.equal(fixture.element('operation-result').dataset.state, 'error');
    });

    await t.test('cause-free error', async () => {
        const error = new Error('Stored package was not found');
        const fixture = await createControllerFixture(module, stored, { readError: error });

        await fixture.element('reopen-package').dispatch('click');

        assert.equal(
            fixture.element('operation-result').textContent,
            'Stored package was not found',
        );
    });

    await t.test('long cause', async () => {
        const cause = new DOMException('x'.repeat(400), 'DataCloneError');
        const error = new Error('Practice-package transaction was aborted', { cause });
        const fixture = await createControllerFixture(module, stored, { readError: error });

        await fixture.element('reopen-package').dispatch('click');

        const message = fixture.element('operation-result').textContent;
        assert.match(message, /\(DataCloneError: x+\.\.\.\)$/);
        assert.equal(message.includes('x'.repeat(241)), false);
    });
});
