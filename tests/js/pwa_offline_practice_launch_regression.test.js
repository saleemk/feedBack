'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { extractFunction } = require('./test_utils');

const ROOT = path.join(__dirname, '..', '..');
const APP_JS = path.join(ROOT, 'static', 'app.js');
const SESSION_JS = path.join(ROOT, 'static', 'js', 'session.js');

test('offline arrangement changes no-op without reconnecting or stopping playback', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const calls = [];
    const arrSelect = { value: '1' };
    const drumSelect = { value: 'drums' };
    const sandbox = {
        currentFilename: 'Offline.sloppak',
        isOfflinePracticeActive: () => true,
        _audioTime: () => 12,
        stopOfflinePracticePlayback: () => { calls.push('stopOfflinePracticePlayback'); },
        setPlayButtonState: (value) => { calls.push(['setPlayButtonState', value]); },
        _songEventPayload: () => ({ time: 12, audioT: 12, chartT: 12, perfNow: 1200 }),
        S: { isPlaying: true },
        window: {
            feedBack: {
                isPlaying: true,
                emit: (event, detail) => { calls.push(['emit', event, detail]); },
            },
            highway: {
                getSongInfo: () => ({ offline: true, arrangement_index: 0 }),
                reconnect: () => { calls.push('reconnect'); },
            },
        },
        document: {
            getElementById(id) {
                if (id === 'arr-select') return arrSelect;
                if (id === 'drum-part-select') return drumSelect;
                return null;
            },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction(src, 'async function changeArrangement('), sandbox);

    await vm.runInContext('changeArrangement(1)', sandbox);

    assert.equal(calls.includes('reconnect'), false);
    assert.equal(calls.includes('stopOfflinePracticePlayback'), false);
    assert.equal(calls.some((call) => Array.isArray(call) && call[0] === 'setPlayButtonState'), false);
    assert.equal(sandbox.S.isPlaying, true);
    assert.equal(sandbox.window.feedBack.isPlaying, true);
    assert.equal(arrSelect.value, '0');
    assert.equal(drumSelect.value, '');
});

test('failed offline highway load stops decoded playback and returns from Player', async () => {
    const src = fs.readFileSync(SESSION_JS, 'utf8');
    const calls = [];
    const sandbox = {
        console,
        readCompletePracticePackage: async () => ({
            metadata: {
                revision: 'a'.repeat(64),
                source: { filename: 'Offline.sloppak' },
                arrangement: { index: 0 },
            },
        }),
        loadOfflinePracticePackage: async () => ({
            metadata: {
                revision: 'a'.repeat(64),
                source: { filename: 'Offline.sloppak' },
                arrangement: { index: 0 },
            },
            messages: [{ type: 'song_info' }, { type: 'ready' }],
            duration: 42,
        }),
        stopOfflinePracticePlayback: () => { calls.push('stopOfflinePracticePlayback'); },
        isOfflinePracticeActive: () => true,
        artAbortController: null,
        _cancelCountIn: () => calls.push('_cancelCountIn'),
        _resetJuceAudioShimChain: () => calls.push('_resetJuceAudioShimChain'),
        _resetAudioSeekState: () => calls.push('_resetAudioSeekState'),
        _resetPlaybackSpeedForNewSong: () => calls.push('_resetPlaybackSpeedForNewSong'),
        clearLoop: () => calls.push('clearLoop'),
        _resetSectionPracticeLog: () => calls.push('_resetSectionPracticeLog'),
        _hideSectionPracticeBar: () => calls.push('_hideSectionPracticeBar'),
        _clearAutoplayHold: () => calls.push('_clearAutoplayHold'),
        _clearAutoExit: () => calls.push('_clearAutoExit'),
        _resolvePlayerOrigin: () => 'v3-songs',
        showScreen: async (id) => { calls.push(['showScreen', id]); },
        loadSavedLoops: () => calls.push('loadSavedLoops'),
        setPlayButtonState: (value) => { calls.push(['setPlayButtonState', value]); },
        _songEventPayload: () => ({ time: 0, audioT: 0, chartT: 0, perfNow: 0 }),
        jucePlayer: { stop: async () => {} },
        audio: { pause: () => calls.push('audio.pause'), src: '' },
        S: { isPlaying: false, lastAudioTime: 0, pendingResume: null },
        currentFilename: '',
        _pendingAutostart: false,
        _playerOriginScreen: 'home',
        window: {
            _juceMode: false,
            _juceAudioUrl: null,
            _currentSongAudio: null,
            _clearJuceRerouteMemo: () => calls.push('_clearJuceRerouteMemo'),
            feedBack: {
                isPlaying: false,
                emit: (event, detail) => calls.push(['emit', event, detail]),
            },
            highway: {
                stop: () => calls.push('highway.stop'),
                init: () => calls.push('highway.init'),
                loadOfflinePractice: async () => { throw new Error('chart load failed'); },
                getRenderScale: () => 1,
            },
        },
        document: {
            getElementById: () => ({ value: '', classList: { contains: () => false } }),
            querySelector: () => ({ id: 'player' }),
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction(src, 'async function playOfflinePracticePackage'), sandbox);

    await assert.rejects(
        () => vm.runInContext('playOfflinePracticePackage("a".repeat(64))', sandbox),
        /chart load failed/,
    );

    assert.ok(calls.filter((call) => call === 'stopOfflinePracticePlayback').length >= 2);
    assert.ok(calls.includes('highway.stop'));
    assert.ok(calls.some((call) => Array.isArray(call) && call[0] === 'showScreen' && call[1] === 'player'));
    assert.ok(calls.some((call) => Array.isArray(call) && call[0] === 'showScreen' && call[1] === 'v3-songs'));
    assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === 'setPlayButtonState'), ['setPlayButtonState', false]);
    assert.equal(sandbox.S.isPlaying, false);
    assert.equal(sandbox.window.feedBack.isPlaying, false);
    assert.equal(sandbox.currentFilename, '');
    assert.equal(sandbox._pendingAutostart, false);
});

test('offline Player teardown does not write a normal resume snapshot', () => {
    const src = fs.readFileSync(SESSION_JS, 'utf8');
    assert.match(
        src,
        /const offlineActive = isOfflinePracticeActive\(\);[\s\S]*if \(hadPlayableSong && !offlineActive\) _snapshotResumeSession\(stopTime\);/,
        'showScreen teardown must skip normal resume snapshots for active offline sessions',
    );
});

test('offline song info reduces and disables unsupported arrangement controls', () => {
    const src = fs.readFileSync(path.join(ROOT, 'static', 'highway.js'), 'utf8');
    const offlineStart = src.indexOf('function _applyOfflineSongInfo');
    const offlineEnd = src.indexOf('async function _finishOfflineReady');
    assert.ok(offlineStart > -1 && offlineEnd > offlineStart, 'offline song-info helper exists');
    const offlineBlock = src.slice(offlineStart, offlineEnd);
    assert.match(offlineBlock, /sel\.textContent = '';/);
    assert.match(offlineBlock, /sel\.disabled = true;/);
    assert.match(offlineBlock, /dpSel\.disabled = true;/);

    const onlineStart = src.indexOf('// Populate arrangement dropdown');
    const onlineEnd = src.indexOf('// Drum-part picker', onlineStart);
    const onlineBlock = src.slice(onlineStart, onlineEnd);
    assert.match(onlineBlock, /sel\) sel\.disabled = false;/);
});

test('normal app offline startup awaits plugins and visualization before one launch', () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const start = src.indexOf('if (offlineLaunchIntent.active) {', src.indexOf('(async () => {'));
    const end = src.indexOf('// Splitscreen pop-out windows', start);
    assert.ok(start > -1 && end > start, 'offline startup branch exists');
    const branch = src.slice(start, end);

    const plugins = branch.indexOf('await bootstrapPluginsAndUi({ watchStartup: false })');
    const viz = branch.indexOf('await _populateVizPicker(');
    const launch = branch.indexOf('await playOfflinePracticePackage(offlineLaunchIntent.revision)');
    assert.ok(plugins > -1 && viz > plugins && launch > viz);
    assert.match(branch, /preserveSelectionOnFallback: true/);
    assert.match(branch, /if \(!offlineLaunchIntent\.revision\)[\s\S]*returnToOfflineRecovery\(\)/);
    assert.match(branch, /catch \(error\)[\s\S]*returnToOfflineRecovery\(\)/);
    assert.equal((branch.match(/playOfflinePracticePackage\(/g) || []).length, 1);
    assert.match(src, /window\.closeCurrentSong = returnToOfflineRecovery/);
    assert.match(src, /if \(offlineLaunchIntent\.active\) \{ returnToOfflineRecovery\(\); return; \}/);
});

test('offline package launch avoids server-backed saved-loop loading', () => {
    const src = fs.readFileSync(SESSION_JS, 'utf8');
    const start = src.indexOf('export async function playOfflinePracticePackage');
    const end = src.indexOf('// Leave the player', start);
    const block = src.slice(start, end);
    assert.doesNotMatch(block, /loadSavedLoops\(\)/);
});
