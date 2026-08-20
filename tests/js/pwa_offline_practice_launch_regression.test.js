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
const HIGHWAY_JS = path.join(ROOT, 'static', 'highway.js');

function storedMetadata(revision, index, name, smartName = name) {
    return {
        revision,
        complete: true,
        source: { filename: 'Offline.sloppak' },
        song: { title: 'Offline', artist: 'Artist', duration: 42 },
        arrangement: { index, name, smartName, namingMode: 'smart', drumPart: null },
    };
}

test('preferred offline package uses exact default name, then index and revision order', () => {
    const src = fs.readFileSync(SESSION_JS, 'utf8');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(extractFunction(src, 'function _offlinePackageOrder'), sandbox);
    vm.runInContext(
        extractFunction(src, 'export function selectPreferredOfflinePracticePackage').replace(/^export /, ''),
        sandbox,
    );
    const leadLater = storedMetadata('d'.repeat(64), 2, 'Lead');
    const rhythm = storedMetadata('c'.repeat(64), 1, 'Rhythm', 'Rhythm Guitar');
    const leadFirst = storedMetadata('a'.repeat(64), 2, 'Lead');
    sandbox.packages = [leadLater, rhythm, leadFirst];

    assert.equal(vm.runInContext('selectPreferredOfflinePracticePackage(packages, "Rhythm Guitar").revision', sandbox), rhythm.revision);
    assert.equal(vm.runInContext('selectPreferredOfflinePracticePackage(packages, "Lead").revision', sandbox), leadFirst.revision);
    assert.equal(vm.runInContext('selectPreferredOfflinePracticePackage(packages, "Vocals").revision', sandbox), rhythm.revision);
});

test('offline Highway selector lists stored siblings in index order and selects the active package', () => {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const events = [];
    const makeTextElement = () => ({ textContent: '', classList: { toggle() {} }, remove() {} });
    const elements = new Map([
        ['hud-artist', makeTextElement()], ['hud-title', makeTextElement()],
        ['hud-arrangement', makeTextElement()], ['hud-tuning', makeTextElement()],
        ['hud-tuning-targets', makeTextElement()], ['audio-error-banner', makeTextElement()],
        ['drum-part-select', { textContent: '', value: 'drums', disabled: false }],
        ['v3-drum-part-row', makeTextElement()],
    ]);
    const arrangementSelect = {
        children: [], value: '', disabled: true,
        appendChild(option) { this.children.push(option); },
        set textContent(_value) { this.children = []; },
    };
    elements.set('arr-select', arrangementSelect);
    const sandbox = {
        hwState: {
            notes: [], beats: [], songInfo: {}, songOffset: 0, stringCount: 6,
        },
        api: { hasPhraseData: () => false },
        document: {
            getElementById: (id) => elements.get(id) || null,
            createElement: () => ({ value: '', selected: false, textContent: '' }),
        },
        window: {
            displayTuningName: () => 'E Standard',
            feedBack: { emit: (event, detail) => events.push([event, detail]), currentSong: null },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction(src, 'function _offlineStringCount'), sandbox);
    vm.runInContext(extractFunction(src, 'function _offlineArrangementLabel'), sandbox);
    vm.runInContext(extractFunction(src, 'function _offlineStoredArrangements'), sandbox);
    vm.runInContext(extractFunction(src, 'function _buildOfflineSongInfo'), sandbox);
    vm.runInContext(extractFunction(src, 'function _applyOfflineSongInfo'), sandbox);
    vm.runInContext(extractFunction(src, 'function _publishOfflineLifecycleEvents'), sandbox);
    sandbox.metadata = storedMetadata('b'.repeat(64), 1, 'Rhythm', 'Rhythm Guitar');
    sandbox.siblings = [
        storedMetadata('c'.repeat(64), 2, 'Bass'),
        storedMetadata('b'.repeat(64), 1, 'Rhythm', 'Rhythm Guitar'),
        storedMetadata('a'.repeat(64), 0, 'Lead'),
    ];
    sandbox.message = {
        type: 'song_info', title: 'Offline', artist: 'Artist', arrangement_index: 1,
        arrangement: 'Rhythm', arrangement_smart_name: 'Rhythm Guitar', naming_mode: 'smart',
    };

    vm.runInContext(`
        stored = _offlineStoredArrangements(metadata, siblings);
        songInfo = _buildOfflineSongInfo(message, metadata, 42, stored);
        _applyOfflineSongInfo(songInfo, metadata, stored);
        _publishOfflineLifecycleEvents();
    `, sandbox);

    assert.deepEqual(arrangementSelect.children.map((option) => Number(option.value)), [0, 1, 2]);
    assert.deepEqual(arrangementSelect.children.map((option) => option.textContent), ['Lead', 'Rhythm Guitar', 'Bass']);
    assert.equal(arrangementSelect.value, '1');
    assert.equal(arrangementSelect.disabled, false);
    assert.equal(elements.get('drum-part-select').disabled, true);
    assert.deepEqual(sandbox.window.feedBack.currentSong.arrangements.map((arrangement) => arrangement.index), [0, 1, 2]);
    assert.ok(events.some(([event]) => event === 'song:loaded'));
});

function replacementSandbox({ failReady = false } = {}) {
    const src = fs.readFileSync(HIGHWAY_JS, 'utf8');
    const events = [];
    const oldNotes = [{ id: 'old-note' }];
    const oldChords = [{ id: 'old-chord' }];
    const oldHandShapes = [{ id: 'old-handshape', start_time: 1 }];
    const oldPhrases = [{ id: 'old-phrase' }];
    const sandbox = {
        hwState: {
            songInfo: { title: 'Old', arrangement_index: 0 }, songOffset: 0.25, stringCount: 6,
            notes: oldNotes, chords: oldChords, handShapes: oldHandShapes,
            beats: [{ id: 'old-beat' }], sections: [{ id: 'old-section' }],
            anchors: [{ fret: 1, width: 4 }], displayMaxFret: 8,
            chordTemplates: [{ id: 'old-template' }], lyrics: [{ text: 'old' }],
            lyricsSource: 'xml', toneChanges: [{ id: 'old-tone' }], toneBase: 'old-base',
            drumTab: { hits: [{ id: 'old-hit' }] }, _phrases: oldPhrases, ready: true,
            _filteredNotes: oldNotes, _filteredChords: oldChords,
            _filteredAnchors: null, _filteredHandShapes: oldHandShapes,
            _phrasesHaveHandShapes: true, _xfNotes: oldNotes, _xfChords: oldChords,
            _xfAnchors: null, _xfNotesAll: oldNotes, _xfChordsAll: oldChords,
            _xfChordTemplates: null, _xfStringCount: null, _xfTuning: null,
            _xfCapo: null, _xfHandShapes: oldHandShapes, _xfCentOffset: null,
            _lastChordOnFretLine: oldChords[0], _chordFretLineNotes: oldNotes,
            _frameMismatchWarned: new Set(['old-warning']), _chordRenderCacheSrc: oldChords,
            _chordRenderCacheInverted: false, _chordRenderCacheTemplates: null,
            _wsGen: 0, ws: null, _juceRoutingPromise: Promise.resolve(),
        },
        api: { hasPhraseData: () => true },
        window: {
            _highwayJuceRoutingPending: false,
            feedBack: {
                currentSong: null,
                emit: (event) => events.push(event),
            },
        },
    };
    sandbox._clearChartTransformStage = () => {
        sandbox.hwState._xfNotes = null;
        sandbox.hwState._xfChords = null;
        sandbox.hwState._xfHandShapes = null;
    };
    sandbox._resetChordRenderState = () => {
        sandbox.hwState._lastChordOnFretLine = null;
        sandbox.hwState._chordFretLineNotes = [];
        sandbox.hwState._frameMismatchWarned.clear();
        sandbox.hwState._chordRenderCacheSrc = null;
    };
    sandbox._finishOfflineReady = async () => {
        sandbox.hwState.ready = true;
        if (failReady) throw new Error('forced ready failure');
    };
    sandbox._applyOfflineSongInfo = () => {
        sandbox.window.feedBack.currentSong = { title: 'New' };
    };
    vm.createContext(sandbox);
    for (const name of [
        '_offlineStringCount', '_offlineStoredArrangements', '_buildOfflineSongInfo',
        '_stageOfflinePracticeChart', '_snapshotOfflinePracticeChart',
        '_restoreOfflinePracticeChart', '_installOfflinePracticeChart',
        '_publishOfflineLifecycleEvents', '_replaceOfflinePracticeChart',
        '_loadOfflinePracticeChart',
    ]) {
        const isAsync = name === '_replaceOfflinePracticeChart' || name === '_loadOfflinePracticeChart';
        vm.runInContext(extractFunction(src, `${isAsync ? 'async ' : ''}function ${name}`), sandbox);
    }
    sandbox.metadata = storedMetadata('b'.repeat(64), 1, 'Rhythm');
    sandbox.messages = [
        { type: 'song_info', title: 'New', arrangement_index: 1 },
        { type: 'notes', data: [{ id: 'new-note-1' }] },
        { type: 'notes', data: [{ id: 'new-note-2' }] },
        { type: 'chords', data: [{ id: 'new-chord' }] },
        { type: 'handshapes', data: [{ id: 'new-handshape', start_time: 2 }] },
        { type: 'phrases', data: [{ id: 'new-phrase' }] },
        { type: 'drum_tab', name: 'Drums' },
        { type: 'drum_hits', data: [{ id: 'new-hit' }] },
        { type: 'ready' },
    ];
    return { sandbox, events, oldNotes, oldChords, oldHandShapes, oldPhrases };
}

test('offline Highway replacement swaps a populated chart without retaining old arrangement data', async () => {
    const { sandbox } = replacementSandbox();

    assert.equal(await vm.runInContext(
        '_replaceOfflinePracticeChart(messages, { metadata, duration: 42, siblings: [metadata] })',
        sandbox,
    ), true);

    assert.deepEqual(Array.from(sandbox.hwState.notes, (item) => item.id), ['new-note-1', 'new-note-2']);
    assert.deepEqual(Array.from(sandbox.hwState.chords, (item) => item.id), ['new-chord']);
    assert.deepEqual(Array.from(sandbox.hwState.handShapes, (item) => item.id), ['new-handshape']);
    assert.deepEqual(Array.from(sandbox.hwState._phrases, (item) => item.id), ['new-phrase']);
    assert.deepEqual(Array.from(sandbox.hwState.drumTab.hits, (item) => item.id), ['new-hit']);
    assert.equal(sandbox.hwState.songInfo.title, 'New');
});

test('failed offline Highway replacement restores the exact populated chart state', async () => {
    const { sandbox } = replacementSandbox({ failReady: true });
    const priorState = { ...sandbox.hwState };
    const priorWarnings = [...sandbox.hwState._frameMismatchWarned];

    await assert.rejects(
        vm.runInContext(
            '_replaceOfflinePracticeChart(messages, { metadata, duration: 42, siblings: [metadata] })',
            sandbox,
        ),
        /forced ready failure/,
    );

    for (const [field, value] of Object.entries(priorState)) {
        assert.equal(sandbox.hwState[field], value, `${field} retains its exact prior value`);
    }
    assert.deepEqual([...sandbox.hwState._frameMismatchWarned], priorWarnings);
});

test('initial offline Highway load publishes lifecycle events in established order', async () => {
    const { sandbox, events } = replacementSandbox();

    assert.equal(await vm.runInContext(
        '_loadOfflinePracticeChart(messages, { metadata, duration: 42, siblings: [metadata] })',
        sandbox,
    ), true);

    assert.deepEqual(events, ['song:loaded', 'beats:loaded', 'song:ready']);
});

test('populated offline Highway replacement publishes lifecycle events in established order', async () => {
    const { sandbox, events } = replacementSandbox();

    assert.equal(await vm.runInContext(
        '_replaceOfflinePracticeChart(messages, { metadata, duration: 42, siblings: [metadata] })',
        sandbox,
    ), true);

    assert.deepEqual(events, ['song:loaded', 'beats:loaded', 'song:ready']);
});

test('failed offline Highway preparation publishes no lifecycle events', async () => {
    const { sandbox, events } = replacementSandbox({ failReady: true });

    await assert.rejects(
        vm.runInContext(
            '_replaceOfflinePracticeChart(messages, { metadata, duration: 42, siblings: [metadata] })',
            sandbox,
        ),
        /forced ready failure/,
    );

    assert.deepEqual(events, []);
});

test('stale session switch cannot replace the latest selected offline arrangement', async () => {
    const src = fs.readFileSync(SESSION_JS, 'utf8');
    const applied = [];
    let releaseFirst;
    const firstRead = new Promise((resolve) => { releaseFirst = resolve; });
    const first = storedMetadata('a'.repeat(64), 1, 'Rhythm');
    const second = storedMetadata('b'.repeat(64), 2, 'Bass');
    const sandbox = {
        _offlinePracticeSiblings: [first, second],
        _offlinePracticeSwitchGeneration: 0,
        isOfflinePracticeActive: () => true,
        offlinePracticeMetadata: () => storedMetadata('0'.repeat(64), 0, 'Lead'),
        readCompletePracticePackage: async (revision) => (
            revision === first.revision ? firstRead : { metadata: second, chart: {} }
        ),
        replaceOfflinePracticeChart: async (record, options) => {
            if (!options.isCurrent()) return null;
            applied.push(record.metadata.revision);
            return { metadata: record.metadata, messages: [{ type: 'song_info' }, { type: 'ready' }], duration: 42, previous: {} };
        },
        restoreOfflinePracticeChart: () => {},
        window: { highway: { replaceOfflinePractice: async () => true } },
    };
    vm.createContext(sandbox);
    vm.runInContext(
        extractFunction(src, 'export async function switchOfflinePracticeArrangement').replace(/^export /, ''),
        sandbox,
    );

    const older = vm.runInContext('switchOfflinePracticeArrangement(1)', sandbox);
    const latest = vm.runInContext('switchOfflinePracticeArrangement(2)', sandbox);
    assert.equal(await latest, true);
    releaseFirst({ metadata: first, chart: {} });
    assert.equal(await older, false);
    assert.deepEqual(applied, [second.revision]);
});

test('offline arrangement changes switch stored charts without reconnecting or stopping playback', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const calls = [];
    const arrSelect = { value: '1' };
    const drumSelect = { value: 'drums' };
    const playButton = {
        attributes: new Set(),
        setAttribute(name) { this.attributes.add(name); },
        removeAttribute(name) { this.attributes.delete(name); },
    };
    const elements = new Map([
        ['arr-select', arrSelect],
        ['drum-part-select', drumSelect],
        ['btn-play', playButton],
    ]);
    const sandbox = {
        currentFilename: 'Offline.sloppak',
        isOfflinePracticeActive: () => true,
        switchOfflinePracticeArrangement: async (index) => { calls.push(['switch', index]); return true; },
        _hideSectionPracticeBar: () => calls.push('_hideSectionPracticeBar'),
        _resetSectionPracticeLog: () => calls.push('_resetSectionPracticeLog'),
        invalidateParentCount: () => calls.push('invalidateParentCount'),
        _arrBusyGen: 0,
        S: { isPlaying: true },
        window: {
            fbNotify: { show: (notice) => calls.push(['notice', notice]) },
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
                return elements.get(id) || null;
            },
            createElement() {
                return {
                    id: '', className: '', innerHTML: '',
                    remove() { elements.delete(this.id); },
                };
            },
            body: { appendChild(element) { elements.set(element.id, element); } },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction(src, 'async function changeArrangement('), sandbox);

    await vm.runInContext('changeArrangement(1)', sandbox);

    assert.equal(calls.includes('reconnect'), false);
    assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === 'switch'), ['switch', 1]);
    assert.equal(sandbox.S.isPlaying, true);
    assert.equal(sandbox.window.feedBack.isPlaying, true);
    assert.equal(arrSelect.value, '1');
    assert.equal(drumSelect.value, '');
    assert.equal(playButton.attributes.has('aria-busy'), false);
    assert.equal(elements.has('arr-loading'), false);
    assert.ok(calls.some((call) => Array.isArray(call) && call[1] === 'song:arrangement-changed'));
    assert.ok(calls.some((call) => Array.isArray(call) && call[1] === 'arrangement:changed'));
});

test('online arrangement changes retain the websocket reconnect path', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const calls = [];
    const elements = new Map();
    const sandbox = {
        currentFilename: 'Online.sloppak',
        isOfflinePracticeActive: () => false,
        hideSongCreditsOverlay: () => {},
        _audioTime: () => 12,
        _audioSeek: async () => ({ completed: true, to: 12 }),
        _songEventPayload: () => ({}),
        _hideSectionPracticeBar: () => {},
        _resetSectionPracticeLog: () => {},
        invalidateParentCount: () => {},
        setPlayButtonState: () => {},
        jucePlayer: { pause: async () => {}, play: async () => true },
        audio: { pause() {}, play: async () => {} },
        S: { isPlaying: false },
        _arrBusyGen: 0,
        _arrBusyTimeout: null,
        setTimeout: () => 1,
        clearTimeout: () => {},
        window: {
            _juceMode: false,
            feedBack: { emit: (event, detail) => calls.push(['emit', event, detail]) },
            highway: {
                _onReady: null,
                reconnect: (...args) => calls.push(['reconnect', ...args]),
            },
        },
        document: {
            getElementById: (id) => elements.get(id) || null,
            createElement: () => ({ id: '', className: '', innerHTML: '', remove() {} }),
            body: { appendChild(element) { elements.set(element.id, element); } },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractFunction(src, 'async function changeArrangement('), sandbox);

    await vm.runInContext('changeArrangement(2)', sandbox);

    assert.deepEqual(calls.find((call) => call[0] === 'reconnect'), ['reconnect', 'Online.sloppak', 2, '']);
    assert.ok(calls.some((call) => call[0] === 'emit' && call[1] === 'arrangement:changed'));
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
                arrangement: { index: 0, name: 'Lead', smartName: 'Lead' },
                complete: true,
            },
        }),
        listCompletePracticePackages: async () => [],
        _offlineSiblingsFor: (metadata) => [metadata],
        selectPreferredOfflinePracticePackage: (packages) => packages[0],
        _defaultArrangement: '',
        _offlinePracticeSiblings: [],
        _resetOfflinePracticeSiblings: () => {},
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

test('offline song info populates stored arrangements while disabling drum parts', () => {
    const src = fs.readFileSync(path.join(ROOT, 'static', 'highway.js'), 'utf8');
    const offlineStart = src.indexOf('function _applyOfflineSongInfo');
    const offlineEnd = src.indexOf('async function _finishOfflineReady');
    assert.ok(offlineStart > -1 && offlineEnd > offlineStart, 'offline song-info helper exists');
    const offlineBlock = src.slice(offlineStart, offlineEnd);
    assert.match(offlineBlock, /sel\.textContent = '';/);
    assert.match(offlineBlock, /storedArrangements\.forEach/);
    assert.match(offlineBlock, /sel\.disabled = storedArrangements\.length <= 1;/);
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
