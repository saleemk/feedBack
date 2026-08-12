import {
    closePracticePackageStore,
    deleteCompletePracticePackage,
    listCompletePracticePackages,
    openPracticePackageStore,
    readCompletePracticePackage,
    saveCompletePracticePackage,
    validatePracticePackageManifest,
} from '../js/practice-package-store.js';

const ERROR_CAUSE_NAME_MAX_CHARACTERS = 64;
const ERROR_CAUSE_MESSAGE_MAX_CHARACTERS = 240;

export function buildPracticeManifestUrl({
    filename,
    arrangement = -1,
    namingMode = 'legacy',
    drumPart = '',
}, baseHref = 'http://localhost/') {
    const url = new URL('/api/practice-package/manifest', baseHref);
    url.searchParams.set('filename', String(filename));
    url.searchParams.set('arrangement', String(arrangement));
    url.searchParams.set('naming_mode', String(namingMode));
    url.searchParams.set('drum_part', String(drumPart));
    return `${url.pathname}${url.search}`;
}

function formatBytes(value) {
    if (!Number.isFinite(value)) return 'Unavailable';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatSeconds(value) {
    return Number.isFinite(value) ? `${value.toFixed(2)} s` : 'Unavailable';
}

function conciseErrorText(value, maxCharacters) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= maxCharacters) return text;
    return `${text.slice(0, maxCharacters - 3)}...`;
}

function formatErrorMessage(error) {
    const message = error instanceof Error ? error.message : String(error);
    const cause = error && typeof error === 'object' ? error.cause : null;
    if (!cause) return message;
    const causeName = conciseErrorText(
        cause.name || 'Error',
        ERROR_CAUSE_NAME_MAX_CHARACTERS,
    );
    const causeMessage = conciseErrorText(
        cause.message || '',
        ERROR_CAUSE_MESSAGE_MAX_CHARACTERS,
    );
    const detail = causeMessage ? `${causeName}: ${causeMessage}` : causeName;
    return `${message} (${detail})`;
}

export function createPracticePackageStorageSpike({
    document: documentRef = globalThis.document,
    navigator: navigatorRef = globalThis.navigator,
    location: locationRef = globalThis.location,
    fetch: fetchRef = globalThis.fetch,
    URL: URLRef = globalThis.URL,
    eventTarget: eventTargetRef = globalThis,
    AudioContext: AudioContextRef = globalThis.AudioContext || globalThis.webkitAudioContext,
    requestAnimationFrame: requestAnimationFrameRef = globalThis.requestAnimationFrame,
    cancelAnimationFrame: cancelAnimationFrameRef = globalThis.cancelAnimationFrame,
    store = {
        open: openPracticePackageStore,
        listPackages: listCompletePracticePackages,
        readPackage: readCompletePracticePackage,
        savePackage: saveCompletePracticePackage,
        deletePackage: deleteCompletePracticePackage,
        close: closePracticePackageStore,
    },
} = {}) {
    let currentRevision = null;
    let audioObjectUrl = null;
    let reopenedPackage = null;
    let probeAudioContext = null;
    let decodedAudioBuffer = null;
    let decodedSource = null;
    let decodedStartTime = 0;
    let decodedStartOffset = 0;
    let decodedTimelineFrame = null;
    let started = false;

    function element(id) {
        const target = documentRef?.getElementById(id);
        if (!target) throw new Error(`Missing practice-package spike element: ${id}`);
        return target;
    }

    function setResult(message, isError = false) {
        const result = element('operation-result');
        result.textContent = message;
        result.dataset.state = isError ? 'error' : 'ok';
    }

    function showError(error) {
        setResult(formatErrorMessage(error), true);
    }

    function setBusy(busy) {
        documentRef.querySelectorAll('button[data-command]').forEach((button) => {
            button.disabled = busy;
        });
    }

    function renderMetadata(metadata) {
        element('package-revision').textContent = metadata?.revision || 'None';
        element('package-selection').textContent = metadata
            ? `${metadata.song.artist} - ${metadata.song.title} / ${metadata.arrangement.name}`
            : 'None';
        element('chart-size').textContent = metadata
            ? formatBytes(metadata.chart.bytes)
            : 'None';
        element('audio-size').textContent = metadata
            ? formatBytes(metadata.audio.bytes)
            : 'None';
    }

    function updateMediaStatus(extra = '') {
        const audio = element('stored-audio');
        const status = [
            `Duration ${formatSeconds(audio.duration)}`,
            `Current ${formatSeconds(audio.currentTime)}`,
        ];
        if (extra) status.push(extra);
        element('media-status').textContent = status.join(' | ');
    }

    function resetDecodedStatus() {
        element('decoded-status').textContent = 'No decoded audio';
        element('decoded-duration').textContent = 'None';
        element('decoded-sample-rate').textContent = 'None';
        element('decoded-channels').textContent = 'None';
        element('decoded-pcm-bytes').textContent = 'None';
        element('decoded-manifest-duration').textContent = 'None';
        element('decoded-duration-difference').textContent = 'None';
        element('decoded-playback-status').textContent = 'Not playing';
    }

    function cancelDecodedTimeline() {
        if (decodedTimelineFrame !== null && typeof cancelAnimationFrameRef === 'function') {
            cancelAnimationFrameRef(decodedTimelineFrame);
        }
        decodedTimelineFrame = null;
    }

    function decodedPlaybackPosition() {
        if (!decodedAudioBuffer || !probeAudioContext || !decodedSource) return 0;
        const elapsed = Math.max(0, probeAudioContext.currentTime - decodedStartTime);
        return Math.min(decodedAudioBuffer.duration, decodedStartOffset + elapsed);
    }

    function updateDecodedPlaybackStatus(outcome = '') {
        const status = [`Current ${formatSeconds(decodedPlaybackPosition())}`];
        if (outcome) status.push(outcome);
        element('decoded-playback-status').textContent = status.join(' | ');
    }

    function updateDecodedTimeline() {
        if (!decodedSource) return;
        updateDecodedPlaybackStatus();
        if (typeof requestAnimationFrameRef === 'function') {
            decodedTimelineFrame = requestAnimationFrameRef(updateDecodedTimeline);
        }
    }

    function stopDecodedPlayback(outcome = 'Stopped') {
        const source = decodedSource;
        const position = decodedPlaybackPosition();
        cancelDecodedTimeline();
        decodedSource = null;
        if (!source) return false;
        try { source.stop(); } catch {}
        try { source.disconnect(); } catch {}
        element('decoded-playback-status').textContent = (
            `Current ${formatSeconds(position)} | ${outcome}`
        );
        return true;
    }

    function releaseDecodedAudio() {
        stopDecodedPlayback();
        decodedAudioBuffer = null;
        decodedStartTime = 0;
        decodedStartOffset = 0;
        resetDecodedStatus();
    }

    function closeProbeAudioContext() {
        const context = probeAudioContext;
        probeAudioContext = null;
        if (!context || typeof context.close !== 'function') return;
        try { Promise.resolve(context.close()).catch(() => {}); } catch {}
    }

    function ensureProbeAudioContext() {
        if (probeAudioContext) return probeAudioContext;
        if (typeof AudioContextRef !== 'function') throw new Error('Web Audio is unavailable');
        try {
            probeAudioContext = new AudioContextRef();
            return probeAudioContext;
        } catch (cause) {
            throw new Error('Unable to create Web Audio context', { cause });
        }
    }

    async function resumeProbeAudioContext(context) {
        if (typeof context.resume !== 'function') return;
        try {
            await context.resume();
        } catch (cause) {
            throw new Error('Unable to resume Web Audio context', { cause });
        }
    }

    function renderDecodedAudio(buffer, metadata) {
        const manifestDuration = metadata?.song?.duration;
        const durationDifference = Number.isFinite(manifestDuration)
            ? buffer.duration - manifestDuration
            : null;
        element('decoded-status').textContent = 'Decoded stored OPFS File';
        element('decoded-duration').textContent = formatSeconds(buffer.duration);
        element('decoded-sample-rate').textContent = `${buffer.sampleRate} Hz`;
        element('decoded-channels').textContent = String(buffer.numberOfChannels);
        element('decoded-pcm-bytes').textContent = formatBytes(
            buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT,
        );
        element('decoded-manifest-duration').textContent = Number.isFinite(manifestDuration)
            ? formatSeconds(manifestDuration)
            : 'Unavailable';
        element('decoded-duration-difference').textContent = durationDifference === null
            ? 'Unavailable'
            : `${durationDifference >= 0 ? '+' : ''}${formatSeconds(durationDifference)}`;
        updateDecodedPlaybackStatus('Ready');
    }

    function releaseAudio() {
        releaseDecodedAudio();
        const audio = element('stored-audio');
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
        if (audioObjectUrl) URLRef.revokeObjectURL(audioObjectUrl);
        audioObjectUrl = null;
        currentRevision = null;
        reopenedPackage = null;
        updateMediaStatus('No package open');
    }

    async function refreshEstimate() {
        const storage = navigatorRef?.storage;
        if (!storage || typeof storage.estimate !== 'function') {
            element('storage-estimate').textContent = 'Unsupported';
            return null;
        }
        try {
            const estimate = await storage.estimate();
            element('storage-estimate').textContent = (
                `${formatBytes(estimate.usage)} used / ${formatBytes(estimate.quota)} quota`
            );
            return estimate;
        } catch (error) {
            element('storage-estimate').textContent = 'Unavailable';
            throw error;
        }
    }

    async function requestPersistence() {
        const storage = navigatorRef?.storage;
        if (!storage || typeof storage.persist !== 'function') {
            element('persistence-result').textContent = 'Unsupported';
            return;
        }
        const persisted = await storage.persist();
        element('persistence-result').textContent = persisted ? 'Granted' : 'Not granted';
        await refreshEstimate();
    }

    async function refreshPackages(preferredRevision = '') {
        const packages = await store.listPackages();
        const select = element('stored-package');
        const selected = preferredRevision || select.value;
        select.replaceChildren();
        for (const metadata of packages) {
            const option = documentRef.createElement('option');
            option.value = metadata.revision;
            option.textContent = (
                `${metadata.song.artist} - ${metadata.song.title} / ${metadata.arrangement.name}`
            );
            select.append(option);
        }
        select.disabled = packages.length === 0;
        if (packages.some((metadata) => metadata.revision === selected)) {
            select.value = selected;
        }
        const selectedMetadata = packages.find((metadata) => metadata.revision === select.value);
        if (currentRevision && selectedMetadata?.revision !== currentRevision) {
            releaseAudio();
        }
        renderMetadata(selectedMetadata || null);
        return packages;
    }

    function localArtifactUrl(candidate, kind) {
        const url = new URLRef(candidate, locationRef.href);
        if (url.origin !== locationRef.origin) {
            throw new Error(`${kind} URL must be same-origin`);
        }
        if (kind === 'Chart' && url.pathname !== '/api/practice-package/chart') {
            throw new Error('Chart URL is not a practice-package chart endpoint');
        }
        if (kind === 'Audio'
                && (!url.pathname.startsWith('/api/sloppak/')
                    || !url.pathname.includes('/file/'))) {
            throw new Error('Audio URL is not a contained sloppak media endpoint');
        }
        return url.href;
    }

    async function fetchArtifact(url, label) {
        const response = await fetchRef(url, { cache: 'no-store' });
        if (!response.ok) throw new Error(`${label} fetch failed (${response.status})`);
        if (!response.body || typeof response.body.pipeTo !== 'function') {
            throw new Error(`${label} response streaming is unavailable`);
        }
        return {
            stream: response.body,
            mediaType: response.headers.get('content-type') || '',
        };
    }

    async function fetchPackageArtifacts(chartUrl, audioUrl) {
        const requests = [
            fetchArtifact(chartUrl, 'Chart'),
            fetchArtifact(audioUrl, 'Audio'),
        ];
        try {
            return await Promise.all(requests);
        } catch (error) {
            const results = await Promise.allSettled(requests);
            await Promise.all(results.map(async (result) => {
                if (result.status !== 'fulfilled') return;
                try { await result.value.stream.cancel(); } catch {}
            }));
            throw error;
        }
    }

    async function downloadPackage() {
        const manifestUrl = buildPracticeManifestUrl({
            filename: element('source-filename').value.trim(),
            arrangement: Number.parseInt(element('arrangement-index').value, 10),
            namingMode: element('naming-mode').value,
            drumPart: element('drum-part').value.trim(),
        }, locationRef.href);
        const manifestResponse = await fetchRef(manifestUrl, { cache: 'no-store' });
        if (!manifestResponse.ok) {
            throw new Error(`Manifest fetch failed (${manifestResponse.status})`);
        }
        const manifest = await manifestResponse.json();
        const descriptor = validatePracticePackageManifest(manifest);
        const chartUrl = localArtifactUrl(descriptor.chartUrl, 'Chart');
        const audioUrl = localArtifactUrl(descriptor.audioUrl, 'Audio');
        const [chart, audio] = await fetchPackageArtifacts(chartUrl, audioUrl);
        const metadata = await store.savePackage(manifest, { chart, audio });
        await refreshPackages(metadata.revision);
        await refreshEstimate();
        setResult(`Stored complete package ${metadata.revision}`);
    }

    async function reopenPackage() {
        const revision = element('stored-package').value;
        if (!revision) throw new Error('No stored package selected');
        const stored = await store.readPackage(revision);
        if (!stored) throw new Error('Stored package was not found');
        releaseAudio();
        reopenedPackage = stored;
        audioObjectUrl = URLRef.createObjectURL(stored.audio);
        currentRevision = revision;
        const audio = element('stored-audio');
        audio.src = audioObjectUrl;
        audio.load();
        renderMetadata(stored.metadata);
        updateMediaStatus('Stored OPFS File open');
        setResult(`Opened ${revision} without a network fetch`);
    }

    async function decodeStoredAudio() {
        if (!reopenedPackage) throw new Error('Reopen a stored package first');
        const packageToDecode = reopenedPackage;
        const context = ensureProbeAudioContext();
        await resumeProbeAudioContext(context);
        let encodedAudio;
        try {
            encodedAudio = await packageToDecode.audio.arrayBuffer();
        } catch (cause) {
            throw new Error('Unable to read stored audio for decoding', { cause });
        }
        let buffer;
        try {
            buffer = await context.decodeAudioData(encodedAudio);
        } catch (cause) {
            throw new Error('Unable to decode stored audio', { cause });
        }
        if (reopenedPackage !== packageToDecode) {
            throw new Error('Stored package changed while decoding');
        }
        stopDecodedPlayback();
        decodedAudioBuffer = buffer;
        decodedStartTime = 0;
        decodedStartOffset = 0;
        renderDecodedAudio(buffer, packageToDecode.metadata);
        setResult(`Decoded stored audio ${formatSeconds(buffer.duration)}`);
    }

    async function playDecodedAudio() {
        if (!decodedAudioBuffer) throw new Error('Decode stored audio first');
        const requested = Number(element('seek-seconds').value);
        if (!Number.isFinite(requested) || requested < 0) {
            throw new Error('Seek position must be a non-negative number');
        }
        const offset = Math.min(requested, decodedAudioBuffer.duration);
        const context = ensureProbeAudioContext();
        await resumeProbeAudioContext(context);
        pauseStoredAudio();
        stopDecodedPlayback();
        if (offset >= decodedAudioBuffer.duration) {
            decodedStartOffset = offset;
            element('decoded-playback-status').textContent = (
                `Current ${formatSeconds(offset)} | Requested offset is at decoded end`
            );
            return;
        }
        const source = context.createBufferSource();
        source.buffer = decodedAudioBuffer;
        source.connect(context.destination);
        decodedSource = source;
        decodedStartTime = context.currentTime;
        decodedStartOffset = offset;
        source.onended = () => {
            if (decodedSource !== source) return;
            cancelDecodedTimeline();
            decodedSource = null;
            element('decoded-playback-status').textContent = (
                `Current ${formatSeconds(decodedAudioBuffer.duration)} | Ended naturally`
            );
        };
        try {
            source.start(0, offset);
        } catch (cause) {
            decodedSource = null;
            try { source.disconnect(); } catch {}
            throw new Error('Unable to start decoded playback', { cause });
        }
        updateDecodedTimeline();
    }

    async function playStoredAudio() {
        if (!audioObjectUrl) throw new Error('Reopen a stored package first');
        await element('stored-audio').play();
        updateMediaStatus('Playing');
    }

    function pauseStoredAudio() {
        element('stored-audio').pause();
        updateMediaStatus('Paused');
    }

    function seekStoredAudio() {
        const audio = element('stored-audio');
        if (!audioObjectUrl) throw new Error('Reopen a stored package first');
        const requested = Number(element('seek-seconds').value);
        if (!Number.isFinite(requested) || requested < 0) {
            throw new Error('Seek position must be a non-negative number');
        }
        const target = Number.isFinite(audio.duration)
            ? Math.min(requested, audio.duration)
            : requested;
        audio.currentTime = target;
        updateMediaStatus(`Seek requested ${formatSeconds(target)}`);
    }

    async function deletePackage() {
        const revision = element('stored-package').value;
        if (!revision) throw new Error('No stored package selected');
        let deletionError = null;
        try {
            await store.deletePackage(revision);
        } catch (error) {
            deletionError = error;
        }
        await refreshPackages();
        await refreshEstimate();
        if (deletionError) throw deletionError;
        setResult(`Deleted ${revision}`);
    }

    function runCommand(command) {
        return async () => {
            setBusy(true);
            try {
                await command();
            } catch (error) {
                showError(error);
            } finally {
                setBusy(false);
            }
        };
    }

    async function start() {
        if (started) return;
        started = true;
        element('request-persistence').addEventListener(
            'click', runCommand(requestPersistence),
        );
        element('refresh-estimate').addEventListener('click', runCommand(refreshEstimate));
        element('download-package').addEventListener('click', runCommand(downloadPackage));
        element('reopen-package').addEventListener('click', runCommand(reopenPackage));
        element('play-audio').addEventListener('click', runCommand(playStoredAudio));
        element('pause-audio').addEventListener('click', pauseStoredAudio);
        element('seek-audio').addEventListener('click', () => {
            try { seekStoredAudio(); } catch (error) { showError(error); }
        });
        element('decode-stored-audio').addEventListener('click', runCommand(decodeStoredAudio));
        element('play-decoded-audio').addEventListener('click', runCommand(playDecodedAudio));
        element('stop-decoded-audio').addEventListener('click', () => {
            stopDecodedPlayback();
        });
        element('delete-package').addEventListener('click', runCommand(deletePackage));
        element('stored-package').addEventListener('change', async () => {
            try { await refreshPackages(); } catch (error) { showError(error); }
        });
        const audio = element('stored-audio');
        audio.addEventListener('durationchange', () => updateMediaStatus());
        audio.addEventListener('timeupdate', () => updateMediaStatus());
        audio.addEventListener('seeked', () => updateMediaStatus('Seek complete'));
        audio.addEventListener('error', () => setResult('Stored media failed to load', true));
        eventTargetRef.addEventListener?.('pagehide', () => {
            releaseAudio();
            closeProbeAudioContext();
            store.close();
        });
        try {
            await store.open();
            await refreshPackages();
            await refreshEstimate();
            setResult('OPFS and metadata storage ready');
        } catch (error) {
            showError(error);
        }
    }

    return Object.freeze({ start, releaseAudio });
}

function boot() {
    void createPracticePackageStorageSpike().start();
}

if (globalThis.document) {
    if (globalThis.document.readyState === 'loading') {
        globalThis.document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
}
