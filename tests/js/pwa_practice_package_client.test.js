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
        'const saveCompletePracticePackage = async () => {};\n'
            + 'const validatePracticePackageManifest = (manifest) => ({\n'
            + '    chartUrl: manifest.chart.url,\n'
            + '    audioUrl: manifest.audio.url,\n'
            + '});',
    );
    importSerial += 1;
    return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + importSerial);
}

function manifest() {
    return {
        schema: 'feedback.practice-package.manifest.v1',
        chart: { url: '/api/practice-package/chart', media_type: 'application/x-ndjson' },
        audio: { url: '/api/sloppak/song/file/full.ogg' },
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
