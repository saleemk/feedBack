'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_PATH = path.join(ROOT, 'static', 'js', 'practice-package-client.js');
let importSerial = 0;

async function loadModule() {
    const source = fs.readFileSync(MODULE_PATH, 'utf8').replace(
        /import \{[\s\S]*?\} from '\.\/practice-package-store\.js';/,
        'const deleteCompletePracticePackage = async () => {};\n'
            + 'const readCompletePracticePackage = async () => null;\n'
            + 'const saveCompletePracticePackage = async () => {};\n'
            + 'const validatePracticePackageManifest = (manifest) => ({\n'
            + '    chartUrl: manifest.chart.url,\n'
            + '    audioUrl: manifest.audio.url,\n'
            + '    metadata: {\n'
            + '        revision: manifest.revision,\n'
            + '        audio: {\n'
            + '            bytes: manifest.audio.bytes,\n'
            + '            expectedSha256: manifest.audio.sha256,\n'
            + '        },\n'
            + '    },\n'
            + '});',
    );
    importSerial += 1;
    return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + importSerial);
}

function manifest({
    revision = 'a'.repeat(64),
    arrangement = 0,
    audioSha256 = 'f'.repeat(64),
    audioBytes = 4096,
} = {}) {
    return {
        schema: 'feedback.practice-package.manifest.v1',
        revision,
        arrangement: { index: arrangement },
        chart: {
            url: `/api/practice-package/chart?arrangement=${arrangement}`,
            media_type: 'application/x-ndjson',
        },
        audio: {
            url: '/api/sloppak/song/file/full.ogg',
            bytes: audioBytes,
            sha256: audioSha256,
        },
    };
}

function trackedStream(label) {
    const tracker = { label, cancelCalls: 0 };
    return {
        tracker,
        stream: {
            pipeTo() {},
            async cancel() { tracker.cancelCalls += 1; },
        },
    };
}

function createBatchHarness({
    arrangements,
    preExisting = [],
    failSaveArrangement = null,
    failDeleteRevision = null,
    failLocalStream = false,
    audioOverrides = {},
} = {}) {
    const records = new Map();
    const manifests = new Map();
    const streams = [];
    const fetchCalls = [];
    const saveCalls = [];
    const readCalls = [];
    const deleteCalls = [];
    const localAudio = {
        arrayBuffer() { throw new Error('audio must not be buffered'); },
        stream() {
            if (failLocalStream) throw new Error('local audio stream failed');
            const tracked = trackedStream(`local-${streams.length}`);
            streams.push(tracked);
            return tracked.stream;
        },
    };

    arrangements.forEach((arrangement, index) => {
        manifests.set(arrangement, manifest({
            revision: String(index + 1).repeat(64),
            arrangement,
            ...audioOverrides[arrangement],
        }));
    });
    preExisting.forEach((arrangement) => {
        const value = manifests.get(arrangement);
        records.set(value.revision, {
            metadata: {
                revision: value.revision,
                arrangement: { index: arrangement },
                audio: { mediaType: 'audio/ogg' },
            },
            audio: localAudio,
        });
    });

    return {
        records,
        streams,
        fetchCalls,
        saveCalls,
        readCalls,
        deleteCalls,
        manifests,
        async fetch(url) {
            fetchCalls.push(url);
            const parsed = new URL(url, 'https://feedback.test/');
            if (parsed.pathname === '/api/practice-package/manifest') {
                const arrangement = Number(parsed.searchParams.get('arrangement'));
                return { ok: true, json: async () => manifests.get(arrangement) };
            }
            if (parsed.pathname === '/api/practice-package/chart') {
                const tracked = trackedStream(`chart-${parsed.searchParams.get('arrangement')}`);
                streams.push(tracked);
                return {
                    ok: true,
                    body: tracked.stream,
                    headers: { get: () => 'application/x-ndjson' },
                };
            }
            if (parsed.pathname.includes('/file/')) {
                const tracked = trackedStream('server-audio');
                streams.push(tracked);
                return {
                    ok: true,
                    body: tracked.stream,
                    headers: { get: () => 'audio/ogg' },
                };
            }
            throw new Error(`unexpected fetch: ${url}`);
        },
        async savePackage(receivedManifest, artifacts) {
            const arrangement = receivedManifest.arrangement.index;
            saveCalls.push({ arrangement, artifacts });
            if (arrangement === failSaveArrangement) {
                throw new Error(`save ${arrangement} failed`);
            }
            const metadata = {
                revision: receivedManifest.revision,
                arrangement: { index: arrangement },
                audio: { mediaType: 'audio/ogg' },
            };
            if (!records.has(metadata.revision)) {
                records.set(metadata.revision, { metadata, audio: localAudio });
            }
            return records.get(metadata.revision).metadata;
        },
        async readPackage(revision) {
            readCalls.push(revision);
            return records.get(revision) || null;
        },
        async deletePackage(revision) {
            deleteCalls.push(revision);
            if (revision === failDeleteRevision) throw new Error(`delete ${revision} failed`);
            records.delete(revision);
        },
    };
}

test('manifest URL uses the approved default chart selection', async () => {
    const module = await loadModule();
    const result = module.buildPracticeManifestUrl({ filename: 'Artist/Song.sloppak' }, 'https://feedback.test/');
    const url = new URL(result, 'https://feedback.test');

    assert.equal(url.searchParams.get('filename'), 'Artist/Song.sloppak');
    assert.equal(url.searchParams.get('arrangement'), '-1');
    assert.equal(url.searchParams.get('naming_mode'), 'smart');
    assert.equal(url.searchParams.get('drum_part'), '');
});

test('artifact fetch cancels a successful sibling when the other fetch fails', async () => {
    const module = await loadModule();
    let cancelCalls = 0;
    const chartStream = {
        pipeTo() {},
        cancel: async () => { cancelCalls += 1; },
    };
    const error = new Error('audio unavailable');
    let call = 0;
    const fetch = async () => {
        call += 1;
        if (call === 1) {
            return { ok: true, body: chartStream, headers: { get: () => 'application/x-ndjson' } };
        }
        throw error;
    };

    await assert.rejects(
        module.fetchPracticePackageArtifacts('/chart', '/audio', { fetch }),
        (received) => received === error,
    );
    assert.equal(cancelCalls, 1);
});

test('artifact fetch cancels an unused non-success response body', async () => {
    const module = await loadModule();
    const failed = trackedStream('failed-chart');
    const sibling = trackedStream('audio-sibling');
    const responses = [
        { ok: false, status: 503, body: failed.stream },
        { ok: true, body: sibling.stream, headers: { get: () => 'audio/ogg' } },
    ];

    await assert.rejects(
        module.fetchPracticePackageArtifacts('/chart', '/audio', {
            fetch: async () => responses.shift(),
        }),
        /Chart fetch failed \(503\)/,
    );

    assert.equal(failed.tracker.cancelCalls, 1);
    assert.equal(sibling.tracker.cancelCalls, 1);
});

test('manifest fetch cancels an unused non-success response body', async () => {
    const module = await loadModule();
    const failed = trackedStream('failed-manifest');

    await assert.rejects(
        module.downloadPracticePackage({
            filename: 'Song.sloppak',
            baseHref: 'https://feedback.test/',
            locationRef: { href: 'https://feedback.test/', origin: 'https://feedback.test' },
            fetch: async () => ({ ok: false, status: 503, body: failed.stream }),
        }),
        /Manifest fetch failed \(503\)/,
    );

    assert.equal(failed.tracker.cancelCalls, 1);
});

test('download validates manifest, keeps both response bodies streaming, and saves once', async () => {
    const module = await loadModule();
    const chartStream = { pipeTo() {} };
    const audioStream = { pipeTo() {} };
    const manifestValue = manifest();
    const responses = [
        { ok: true, json: async () => manifestValue },
        { ok: true, body: chartStream, headers: { get: () => 'application/x-ndjson; charset=utf-8' } },
        { ok: true, body: audioStream, headers: { get: () => 'audio/ogg' } },
    ];
    const fetchCalls = [];
    let saved = null;
    const result = await module.downloadPracticePackage({
        filename: 'Song.sloppak',
        baseHref: 'https://feedback.test/static/v3/songs.html',
        locationRef: { href: 'https://feedback.test/static/v3/songs.html', origin: 'https://feedback.test' },
        fetch: async (url) => {
            fetchCalls.push(url);
            return responses.shift();
        },
        savePackage: async (receivedManifest, artifacts) => {
            saved = { receivedManifest, artifacts };
            return { revision: 'a'.repeat(64) };
        },
    });

    assert.equal(result.revision, 'a'.repeat(64));
    assert.match(fetchCalls[0], /naming_mode=smart/);
    assert.equal(saved.receivedManifest, manifestValue);
    assert.equal(saved.artifacts.chart.stream, chartStream);
    assert.equal(saved.artifacts.audio.stream, audioStream);
});

test('artifact URLs remain contained to the approved same-origin endpoints', async () => {
    const module = await loadModule();
    const response = { ok: true, json: async () => ({
        ...manifest(),
        chart: { url: 'https://evil.test/chart' },
    }) };

    await assert.rejects(
        module.downloadPracticePackage({
            filename: 'Song.sloppak',
            baseHref: 'https://feedback.test/',
            locationRef: { href: 'https://feedback.test/', origin: 'https://feedback.test' },
            fetch: async () => response,
        }),
        /Chart URL must be same-origin/,
    );
});

test('batch download preserves requested order and fetches server audio once', async () => {
    const module = await loadModule();
    const harness = createBatchHarness({ arrangements: [2, 0, 3] });

    const result = await module.downloadPracticePackages({
        filename: 'Song.sloppak',
        arrangementIndexes: [2, 0, 3],
        baseHref: 'https://feedback.test/',
        locationRef: { href: 'https://feedback.test/', origin: 'https://feedback.test' },
        fetch: harness.fetch,
        savePackage: harness.savePackage,
        readPackage: harness.readPackage,
        deletePackage: harness.deletePackage,
    });

    assert.deepEqual(result.map((entry) => entry.arrangement.index), [2, 0, 3]);
    assert.deepEqual(harness.saveCalls.map((entry) => entry.arrangement), [2, 0, 3]);
    assert.equal(
        harness.fetchCalls.filter((url) => new URL(url, 'https://feedback.test/').pathname.includes('/file/')).length,
        1,
    );
    assert.equal(harness.streams.filter(({ tracker }) => tracker.label === 'server-audio').length, 1);
    assert.equal(harness.streams.filter(({ tracker }) => tracker.label.startsWith('local-')).length, 2);
    assert.notEqual(
        harness.saveCalls[1].artifacts.audio.stream,
        harness.saveCalls[2].artifacts.audio.stream,
    );
    assert.deepEqual(harness.deleteCalls, []);
});

test('batch input validation rejects before network or storage work', async () => {
    const module = await loadModule();
    const calls = [];
    const dependencies = {
        filename: 'Song.sloppak',
        fetch: async () => { calls.push('fetch'); },
        savePackage: async () => { calls.push('save'); },
        readPackage: async () => { calls.push('read'); },
        deletePackage: async () => { calls.push('delete'); },
    };

    for (const arrangementIndexes of [[], [1.5], [2, 2]]) {
        await assert.rejects(
            module.downloadPracticePackages({ ...dependencies, arrangementIndexes }),
            TypeError,
        );
    }

    assert.deepEqual(calls, []);
});

test('batch rejects audio hash or byte-count mismatches before fetching the later chart', async (t) => {
    const module = await loadModule();
    for (const [name, override] of [
        ['SHA-256', { audioSha256: 'e'.repeat(64) }],
        ['byte count', { audioBytes: 8192 }],
    ]) {
        await t.test(name, async () => {
            const harness = createBatchHarness({
                arrangements: [1, 2],
                audioOverrides: { 2: override },
            });

            await assert.rejects(
                module.downloadPracticePackages({
                    filename: 'Song.sloppak',
                    arrangementIndexes: [1, 2],
                    baseHref: 'https://feedback.test/',
                    locationRef: { href: 'https://feedback.test/', origin: 'https://feedback.test' },
                    fetch: harness.fetch,
                    savePackage: harness.savePackage,
                    readPackage: harness.readPackage,
                    deletePackage: harness.deletePackage,
                }),
                /do not reference the same full-mix audio/,
            );

            assert.equal(harness.fetchCalls.filter((url) => url.includes('/chart')).length, 1);
            assert.equal(harness.fetchCalls.filter((url) => url.includes('/file/')).length, 1);
            assert.deepEqual(harness.deleteCalls, ['1'.repeat(64)]);
        });
    }
});

test('later save failure cancels unused streams and rolls back in reverse order', async () => {
    const module = await loadModule();
    const harness = createBatchHarness({
        arrangements: [1, 2, 3],
        failSaveArrangement: 3,
    });

    await assert.rejects(
        module.downloadPracticePackages({
            filename: 'Song.sloppak',
            arrangementIndexes: [1, 2, 3],
            baseHref: 'https://feedback.test/',
            locationRef: { href: 'https://feedback.test/', origin: 'https://feedback.test' },
            fetch: harness.fetch,
            savePackage: harness.savePackage,
            readPackage: harness.readPackage,
            deletePackage: harness.deletePackage,
        }),
        /save 3 failed/,
    );

    assert.deepEqual(harness.deleteCalls, ['2'.repeat(64), '1'.repeat(64)]);
    assert.equal(harness.streams.find(({ tracker }) => tracker.label === 'chart-3').tracker.cancelCalls, 1);
    assert.equal(harness.streams.filter(({ tracker }) => tracker.label.startsWith('local-')).at(-1).tracker.cancelCalls, 1);
});

test('local audio stream failure cancels the chart fetched for reuse', async () => {
    const module = await loadModule();
    const harness = createBatchHarness({
        arrangements: [1, 2],
        failLocalStream: true,
    });

    await assert.rejects(module.downloadPracticePackages({
        filename: 'Song.sloppak',
        arrangementIndexes: [1, 2],
        baseHref: 'https://feedback.test/',
        locationRef: { href: 'https://feedback.test/', origin: 'https://feedback.test' },
        fetch: harness.fetch,
        savePackage: harness.savePackage,
        readPackage: harness.readPackage,
        deletePackage: harness.deletePackage,
    }), /local audio stream failed/);

    assert.equal(harness.streams.find(({ tracker }) => tracker.label === 'chart-2').tracker.cancelCalls, 1);
    assert.deepEqual(harness.deleteCalls, ['1'.repeat(64)]);
});

test('batch rollback never deletes a package that existed before the call', async () => {
    const module = await loadModule();
    const harness = createBatchHarness({
        arrangements: [1, 2, 3],
        preExisting: [1],
        failSaveArrangement: 3,
    });

    await assert.rejects(module.downloadPracticePackages({
        filename: 'Song.sloppak',
        arrangementIndexes: [1, 2, 3],
        baseHref: 'https://feedback.test/',
        locationRef: { href: 'https://feedback.test/', origin: 'https://feedback.test' },
        fetch: harness.fetch,
        savePackage: harness.savePackage,
        readPackage: harness.readPackage,
        deletePackage: harness.deletePackage,
    }));

    assert.deepEqual(harness.deleteCalls, ['2'.repeat(64)]);
    assert.equal(harness.records.has('1'.repeat(64)), true);
});

test('batch preserves the original error and reports rollback cleanup failures', async () => {
    const module = await loadModule();
    const secondRevision = '2'.repeat(64);
    const harness = createBatchHarness({
        arrangements: [1, 2, 3],
        failSaveArrangement: 3,
        failDeleteRevision: secondRevision,
    });

    await assert.rejects(
        module.downloadPracticePackages({
            filename: 'Song.sloppak',
            arrangementIndexes: [1, 2, 3],
            baseHref: 'https://feedback.test/',
            locationRef: { href: 'https://feedback.test/', origin: 'https://feedback.test' },
            fetch: harness.fetch,
            savePackage: harness.savePackage,
            readPackage: harness.readPackage,
            deletePackage: harness.deletePackage,
        }),
        (error) => {
            assert.equal(error.message, 'save 3 failed');
            assert.equal(error.cleanupErrors.length, 1);
            assert.equal(error.cleanupErrors[0].revision, secondRevision);
            assert.match(error.cleanupErrors[0].error.message, /delete .* failed/);
            return true;
        },
    );

    assert.deepEqual(harness.deleteCalls, [secondRevision, '1'.repeat(64)]);
    assert.equal(harness.records.has(secondRevision), true);
    assert.equal(harness.records.has('1'.repeat(64)), false);
});
