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

function packageRecord(chartText = '{"type":"song_info","title":"Song"}\n{"type":"ready"}\n') {
    return {
        metadata: {
            revision: 'a'.repeat(64),
            source: { filename: 'Song.sloppak' },
            song: { title: 'Song', artist: 'Artist', duration: 30 },
            arrangement: { index: 0, name: 'Lead', smartName: 'Lead' },
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
