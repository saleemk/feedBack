const DEFAULT_AUDIO_CONTEXT = () => globalThis.AudioContext || globalThis.webkitAudioContext;

let audioContext = null;
let activeSession = null;
let endedHandler = null;

function clampTime(value, duration) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return 0;
    return Math.max(0, Math.min(seconds, Number.isFinite(duration) ? duration : seconds));
}

function requireBlob(value, label) {
    if (!value || typeof value.arrayBuffer !== 'function') {
        throw new Error(`${label} is unavailable`);
    }
    return value;
}

function requireMetadata(value) {
    if (!value || typeof value !== 'object') throw new Error('Offline package metadata is unavailable');
    if (!value.revision) throw new Error('Offline package revision is unavailable');
    return value;
}

function normalizedFilename(value) {
    if (typeof value !== 'string') return '';
    try { return decodeURIComponent(value); } catch { return value; }
}

export function parseOfflinePracticeChart(text) {
    const messages = [];
    const lines = String(text || '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        let message;
        try {
            message = JSON.parse(line);
        } catch (error) {
            throw new Error(`Stored chart line ${index + 1} is not valid JSON`);
        }
        if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
            throw new Error(`Stored chart line ${index + 1} is not a highway message`);
        }
        messages.push(message);
    }
    if (!messages.length) throw new Error('Stored chart is empty');
    if (messages[0].type !== 'song_info') throw new Error('Stored chart is missing song metadata');
    if (messages[messages.length - 1].type !== 'ready') throw new Error('Stored chart is incomplete');
    return messages;
}

async function ensureAudioContext(AudioContextClass = DEFAULT_AUDIO_CONTEXT()) {
    if (!AudioContextClass) throw new Error('Web Audio is unavailable');
    if (!audioContext) audioContext = new AudioContextClass();
    return audioContext;
}

function stopSource(session) {
    if (!session?.source) return;
    const source = session.source;
    session.source = null;
    source.onended = null;
    try { source.stop(); } catch (_) {}
    try { source.disconnect(); } catch (_) {}
}

function currentTimeFor(session) {
    if (!session) return 0;
    if (!session.playing) return clampTime(session.position, session.duration);
    const elapsed = (session.context.currentTime - session.startedAt) * session.playbackRate;
    return clampTime(session.position + elapsed, session.duration);
}

function startSource(session) {
    stopSource(session);
    const source = session.context.createBufferSource();
    source.buffer = session.buffer;
    source.playbackRate.value = session.playbackRate;
    source.connect(session.context.destination);
    session.source = source;
    session.startedAt = session.context.currentTime;
    source.onended = () => {
        if (activeSession !== session || !session.playing) return;
        session.position = session.duration;
        session.playing = false;
        session.source = null;
        if (typeof endedHandler === 'function') endedHandler();
    };
    source.start(0, clampTime(session.position, session.duration));
}

export async function loadOfflinePracticePackage(packageRecord, {
    AudioContextClass = DEFAULT_AUDIO_CONTEXT(),
} = {}) {
    const metadata = requireMetadata(packageRecord?.metadata);
    const chart = requireBlob(packageRecord?.chart, 'Stored chart');
    const audio = requireBlob(packageRecord?.audio, 'Stored audio');
    const messages = parseOfflinePracticeChart(await chart.text());
    const context = await ensureAudioContext(AudioContextClass);
    let buffer;
    try {
        buffer = await context.decodeAudioData(await audio.arrayBuffer());
    } catch (error) {
        throw new Error('Stored audio could not be decoded');
    }
    stopOfflinePracticePlayback();
    activeSession = {
        metadata,
        messages,
        context,
        buffer,
        duration: buffer.duration,
        position: 0,
        startedAt: 0,
        playbackRate: 1,
        playing: false,
        source: null,
    };
    return {
        metadata,
        messages,
        duration: buffer.duration,
    };
}

export async function replaceOfflinePracticeChart(packageRecord, {
    isCurrent = () => true,
} = {}) {
    const session = activeSession;
    if (!session) throw new Error('Offline practice is not active');
    const metadata = requireMetadata(packageRecord?.metadata);
    const chart = requireBlob(packageRecord?.chart, 'Stored chart');
    const activeFilename = normalizedFilename(session.metadata?.source?.filename);
    const targetFilename = normalizedFilename(metadata?.source?.filename);
    if (!activeFilename || !targetFilename || activeFilename !== targetFilename) {
        throw new Error('Stored arrangement belongs to a different song');
    }
    const messages = parseOfflinePracticeChart(await chart.text());
    if (!isCurrent()) return null;
    const previous = {
        metadata: session.metadata,
        messages: session.messages,
    };
    session.metadata = metadata;
    session.messages = messages;
    return {
        metadata,
        messages,
        duration: session.duration,
        previous,
    };
}

export function restoreOfflinePracticeChart(snapshot) {
    if (!activeSession || !snapshot?.metadata || !Array.isArray(snapshot.messages)) return false;
    activeSession.metadata = snapshot.metadata;
    activeSession.messages = snapshot.messages;
    return true;
}

export function stopOfflinePracticePlayback() {
    const session = activeSession;
    if (!session) return;
    stopSource(session);
    activeSession = null;
}

export function isOfflinePracticeActive() {
    return Boolean(activeSession);
}

export function offlinePracticeMetadata() {
    return activeSession?.metadata || null;
}

export function offlinePracticeCurrentTime() {
    return currentTimeFor(activeSession);
}

export function offlinePracticeDuration() {
    return activeSession ? activeSession.duration : NaN;
}

export function offlinePracticePlaybackRate() {
    return activeSession ? activeSession.playbackRate : 1;
}

export function setOfflinePracticePlaybackRate(rate) {
    const next = Number(rate);
    if (!activeSession || !Number.isFinite(next) || next <= 0) return;
    const wasPlaying = activeSession.playing;
    activeSession.position = currentTimeFor(activeSession);
    activeSession.playbackRate = next;
    if (wasPlaying) startSource(activeSession);
}

export async function playOfflinePractice() {
    const session = activeSession;
    if (!session) return false;
    if (session.context.state === 'suspended') await session.context.resume();
    if (session.playing) return true;
    if (session.position >= session.duration) session.position = 0;
    startSource(session);
    session.playing = true;
    return true;
}

export function pauseOfflinePractice() {
    const session = activeSession;
    if (!session || !session.playing) return;
    session.position = currentTimeFor(session);
    session.playing = false;
    stopSource(session);
}

export async function seekOfflinePractice(seconds) {
    const session = activeSession;
    if (!session) return NaN;
    const wasPlaying = session.playing;
    session.position = clampTime(seconds, session.duration);
    session.playing = false;
    stopSource(session);
    if (wasPlaying) {
        session.playing = true;
        startSource(session);
    }
    return currentTimeFor(session);
}

export function setOfflinePracticeEndedHandler(handler) {
    endedHandler = typeof handler === 'function' ? handler : null;
}
