'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const MODULE_PATH = path.join(ROOT, 'static', 'js', 'offline-practice-player.js');
let importSerial = 0;

async function loadModule() {
    const source = fs.readFileSync(MODULE_PATH, 'utf8');
    importSerial += 1;
    return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64') + '#' + importSerial);
}

function packageRecord(
    chartText = '{"type":"song_info","title":"Song"}\n{"type":"ready"}\n',
    { revision = 'a'.repeat(64), filename = 'Song.sloppak', index = 0, name = 'Lead' } = {},
) {
    return {
        metadata: {
            revision,
            source: { filename },
            song: { title: 'Song', artist: 'Artist', duration: 30 },
            arrangement: { index, name, smartName: name },
        },
        chart: new Blob([chartText], { type: 'application/x-ndjson' }),
        audio: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/ogg' }),
    };
}

function fakeAudioContextClass({ duration = 30 } = {}) {
    const instances = [];
    class FakeAudioContext {
        constructor() {
            this.currentTime = 0;
            this.destination = {};
            this.state = 'running';
            this.sources = [];
            instances.push(this);
        }

        async decodeAudioData(buffer) {
            this.decodeCalls = (this.decodeCalls || 0) + 1;
            this.decodedBytes = buffer.byteLength;
            return { duration };
        }

        createBufferSource() {
            const source = {
                buffer: null,
                playbackRate: { value: 1 },
                connect: (destination) => { source.destination = destination; },
                disconnect: () => { source.disconnected = true; },
                start: (when, offset) => {
                    source.when = when;
                    source.offset = offset;
                    source.started = true;
                },
                stop: () => { source.stopped = true; },
                onended: null,
            };
            this.sources.push(source);
            return source;
        }

        async resume() {
            this.state = 'running';
        }
    }
    FakeAudioContext.instances = instances;
    return FakeAudioContext;
}

test('parseOfflinePracticeChart requires canonical stored chart boundaries', async () => {
    const module = await loadModule();

    assert.deepEqual(
        module.parseOfflinePracticeChart('{"type":"song_info"}\n{"type":"ready"}\n').map((msg) => msg.type),
        ['song_info', 'ready'],
    );
    assert.throws(
        () => module.parseOfflinePracticeChart('{"type":"ready"}\n'),
        /missing song metadata/,
    );
    assert.throws(
        () => module.parseOfflinePracticeChart('{"type":"song_info"}\n'),
        /incomplete/,
    );
    assert.throws(
        () => module.parseOfflinePracticeChart('not-json\n{"type":"ready"}\n'),
        /line 1/,
    );
});

test('offline practice transport decodes, plays, pauses, seeks, and clamps to decoded duration', async () => {
    const module = await loadModule();
    const FakeAudioContext = fakeAudioContextClass({ duration: 42 });

    const loaded = await module.loadOfflinePracticePackage(packageRecord(), {
        AudioContextClass: FakeAudioContext,
    });
    const context = FakeAudioContext.instances[0];

    assert.equal(loaded.duration, 42);
    assert.equal(module.offlinePracticeDuration(), 42);
    assert.equal(context.decodedBytes, 3);

    assert.equal(await module.playOfflinePractice(), true);
    assert.equal(context.sources.length, 1);
    assert.equal(context.sources[0].offset, 0);
    context.currentTime = 5;
    assert.equal(module.offlinePracticeCurrentTime(), 5);

    module.pauseOfflinePractice();
    assert.equal(context.sources[0].stopped, true);
    assert.equal(module.offlinePracticeCurrentTime(), 5);

    await module.seekOfflinePractice(99);
    assert.equal(module.offlinePracticeCurrentTime(), 42);
    assert.equal(await module.playOfflinePractice(), true);
    assert.equal(context.sources[1].offset, 0);
});

test('offline practice transport restarts an active source when seeking during playback', async () => {
    const module = await loadModule();
    const FakeAudioContext = fakeAudioContextClass({ duration: 60 });
    await module.loadOfflinePracticePackage(packageRecord(), { AudioContextClass: FakeAudioContext });
    const context = FakeAudioContext.instances[0];

    await module.playOfflinePractice();
    await module.seekOfflinePractice(12);

    assert.equal(context.sources[0].stopped, true);
    assert.equal(context.sources[1].offset, 12);
    assert.equal(module.offlinePracticeCurrentTime(), 12);
});

test('chart replacement preserves decoded audio, position, playing state, and playback rate', async () => {
    const module = await loadModule();
    const FakeAudioContext = fakeAudioContextClass({ duration: 60 });
    await module.loadOfflinePracticePackage(packageRecord(), { AudioContextClass: FakeAudioContext });
    const context = FakeAudioContext.instances[0];
    await module.playOfflinePractice();
    context.currentTime = 8;
    module.setOfflinePracticePlaybackRate(1.25);
    context.currentTime = 10;
    const source = context.sources.at(-1);
    const position = module.offlinePracticeCurrentTime();

    const replacement = await module.replaceOfflinePracticeChart(packageRecord(
        '{"type":"song_info","title":"Song","arrangement_index":1}\n{"type":"notes","data":[{"t":1}]}\n{"type":"ready"}\n',
        { revision: 'b'.repeat(64), index: 1, name: 'Rhythm' },
    ));

    assert.equal(replacement.metadata.arrangement.index, 1);
    assert.equal(module.offlinePracticeMetadata().revision, 'b'.repeat(64));
    assert.equal(context.decodeCalls, 1);
    assert.equal(context.sources.at(-1), source);
    assert.equal(source.stopped, undefined);
    assert.equal(module.offlinePracticePlaybackRate(), 1.25);
    assert.equal(module.offlinePracticeCurrentTime(), position);
    module.pauseOfflinePractice();
    const pausedAt = module.offlinePracticeCurrentTime();
    await module.replaceOfflinePracticeChart(packageRecord(
        '{"type":"song_info","title":"Song","arrangement_index":0}\n{"type":"ready"}\n',
    ));
    assert.equal(module.offlinePracticeCurrentTime(), pausedAt);
    assert.equal(context.decodeCalls, 1);
});

test('invalid or wrong-song replacement leaves the prior offline chart active', async () => {
    const module = await loadModule();
    const FakeAudioContext = fakeAudioContextClass();
    await module.loadOfflinePracticePackage(packageRecord(), { AudioContextClass: FakeAudioContext });

    await assert.rejects(
        module.replaceOfflinePracticeChart(packageRecord('not-json', {
            revision: 'b'.repeat(64), index: 1, name: 'Rhythm',
        })),
        /line 1/,
    );
    assert.equal(module.offlinePracticeMetadata().revision, 'a'.repeat(64));

    await assert.rejects(
        module.replaceOfflinePracticeChart(packageRecord(undefined, {
            revision: 'c'.repeat(64), filename: 'Other.sloppak', index: 1, name: 'Rhythm',
        })),
        /different song/,
    );
    assert.equal(module.offlinePracticeMetadata().revision, 'a'.repeat(64));
    assert.equal(FakeAudioContext.instances[0].decodeCalls, 1);
    assert.equal(await module.playOfflinePractice(), true);
    assert.equal(FakeAudioContext.instances[0].sources.at(-1).started, true);
});

test('stale chart replacement cannot overwrite the latest requested chart', async () => {
    const module = await loadModule();
    const FakeAudioContext = fakeAudioContextClass();
    await module.loadOfflinePracticePackage(packageRecord(), { AudioContextClass: FakeAudioContext });
    let generation = 1;
    let releaseSlow;
    const slowChart = {
        arrayBuffer: async () => new ArrayBuffer(0),
        text: () => new Promise((resolve) => { releaseSlow = () => resolve(
            '{"type":"song_info","title":"Song","arrangement_index":1}\n{"type":"ready"}\n',
        ); }),
    };
    const slow = module.replaceOfflinePracticeChart({
        ...packageRecord(undefined, { revision: 'b'.repeat(64), index: 1, name: 'Rhythm' }),
        chart: slowChart,
    }, { isCurrent: () => generation === 1 });
    await Promise.resolve();
    generation = 2;
    await module.replaceOfflinePracticeChart(packageRecord(undefined, {
        revision: 'c'.repeat(64), index: 2, name: 'Bass',
    }), { isCurrent: () => generation === 2 });
    releaseSlow();

    assert.equal(await slow, null);
    assert.equal(module.offlinePracticeMetadata().revision, 'c'.repeat(64));
});
