export const PRACTICE_PACKAGE_DB_NAME = 'feedback-practice-packages';
export const PRACTICE_PACKAGE_DB_VERSION = 1;
export const PRACTICE_PACKAGE_METADATA_STORE = 'packages';
export const PRACTICE_PACKAGE_CHART_MAX_BYTES = 32 * 1024 * 1024;
export const PRACTICE_PACKAGE_ROOT_DIRECTORY = 'practice-packages';
export const PRACTICE_PACKAGE_CHART_FILENAME = 'chart.ndjson';
export const PRACTICE_PACKAGE_AUDIO_FILENAME = 'audio.ogg';
export const PRACTICE_PACKAGE_SHARED_AUDIO_DIRECTORY = 'audio';
export const PRACTICE_PACKAGE_AUDIO_LOCK_NAME = 'feedback-practice-packages:audio:v1';

const MANIFEST_SCHEMA = 'feedback.practice-package.manifest.v1';
const CHART_MEDIA_TYPE = 'application/x-ndjson';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_TEXT_CHARACTERS = 2048;

export class PracticePackageStoreError extends Error {
    constructor(message, cause = null) {
        super(message);
        this.name = 'PracticePackageStoreError';
        if (cause) this.cause = cause;
    }
}

function unavailable(message, cause = null) {
    if (cause instanceof PracticePackageStoreError) return cause;
    return new PracticePackageStoreError(message, cause);
}

function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value, label) {
    if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
    return value;
}

function requireOwn(record, field, label) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
        throw new TypeError(`${label} ${field} must be an own property`);
    }
    return record[field];
}

function requireString(record, field, label, { nonEmpty = false } = {}) {
    const value = requireOwn(record, field, label);
    if (typeof value !== 'string' || (nonEmpty && !value)) {
        throw new TypeError(`${label} ${field} must be ${nonEmpty ? 'a non-empty' : 'a'} string`);
    }
    if (Array.from(value).length > MAX_TEXT_CHARACTERS) {
        throw new TypeError(`${label} ${field} is too long`);
    }
    return value;
}

function requireSha256(value, label) {
    if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
        throw new TypeError(`${label} must be lowercase 64-character SHA-256 hex`);
    }
    return value;
}

function requireSafeInteger(value, label, { positive = false } = {}) {
    if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
        throw new TypeError(`${label} must be a ${positive ? 'positive' : 'non-negative'} safe integer`);
    }
    return value;
}

function requireFiniteNumber(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(`${label} must be a non-negative finite number`);
    }
    return value;
}

function normalizeMediaType(value) {
    return String(value || '').split(';', 1)[0].trim().toLowerCase();
}

function copyDrumPart(value, label) {
    if (value === null) return null;
    const record = requireRecord(value, label);
    return {
        id: requireString(record, 'id', label, { nonEmpty: true }),
        name: requireString(record, 'name', label, { nonEmpty: true }),
    };
}

function copySelection(record, label) {
    const value = requireRecord(record, label);
    const namingMode = requireString(value, 'naming_mode', label);
    if (namingMode !== 'legacy' && namingMode !== 'smart') {
        throw new TypeError(`${label} naming_mode must be legacy or smart`);
    }
    return {
        index: requireSafeInteger(requireOwn(value, 'index', label), `${label} index`),
        name: requireString(value, 'name', label),
        smartName: requireString(value, 'smart_name', label),
        namingMode,
        drumPart: copyDrumPart(requireOwn(value, 'drum_part', label), `${label} drum_part`),
    };
}

export function validatePracticePackageManifest(manifest) {
    const value = requireRecord(manifest, 'manifest');
    const schema = requireString(value, 'schema', 'manifest');
    if (schema !== MANIFEST_SCHEMA) {
        throw new TypeError(`manifest schema must be ${MANIFEST_SCHEMA}`);
    }
    const revision = requireSha256(
        requireString(value, 'revision', 'manifest'),
        'manifest revision',
    );
    const source = requireRecord(requireOwn(value, 'source', 'manifest'), 'manifest source');
    const song = requireRecord(requireOwn(value, 'song', 'manifest'), 'manifest song');
    const chart = requireRecord(requireOwn(value, 'chart', 'manifest'), 'manifest chart');
    const audio = requireRecord(requireOwn(value, 'audio', 'manifest'), 'manifest audio');
    const chartMediaType = normalizeMediaType(
        requireString(chart, 'media_type', 'manifest chart', { nonEmpty: true }),
    );
    if (chartMediaType !== CHART_MEDIA_TYPE) {
        throw new TypeError(`manifest chart media_type must be ${CHART_MEDIA_TYPE}`);
    }
    const chartBytes = requireSafeInteger(
        requireOwn(chart, 'bytes', 'manifest chart'),
        'manifest chart bytes',
        { positive: true },
    );
    if (chartBytes > PRACTICE_PACKAGE_CHART_MAX_BYTES) {
        throw new TypeError('manifest chart exceeds the practice-package byte limit');
    }
    return {
        metadata: {
            revision,
            schema,
            source: {
                filename: requireString(source, 'filename', 'manifest source', { nonEmpty: true }),
            },
            song: {
                title: requireString(song, 'title', 'manifest song'),
                artist: requireString(song, 'artist', 'manifest song'),
                duration: requireFiniteNumber(
                    requireOwn(song, 'duration', 'manifest song'),
                    'manifest song duration',
                ),
            },
            arrangement: copySelection(
                requireOwn(value, 'arrangement', 'manifest'),
                'manifest arrangement',
            ),
            chart: {
                mediaType: chartMediaType,
                bytes: chartBytes,
                sha256: requireSha256(
                    requireString(chart, 'sha256', 'manifest chart'),
                    'manifest chart sha256',
                ),
                integrityVerified: true,
            },
            audio: {
                bytes: requireSafeInteger(
                    requireOwn(audio, 'bytes', 'manifest audio'),
                    'manifest audio bytes',
                    { positive: true },
                ),
                expectedSha256: requireSha256(
                    requireString(audio, 'sha256', 'manifest audio'),
                    'manifest audio sha256',
                ),
                integrityVerified: false,
            },
        },
        chartUrl: requireString(chart, 'url', 'manifest chart', { nonEmpty: true }),
        audioUrl: requireString(audio, 'url', 'manifest audio', { nonEmpty: true }),
    };
}

function copyStoredMetadata(record) {
    const value = requireRecord(record, 'stored package metadata');
    const schema = requireString(value, 'schema', 'stored package metadata');
    if (schema !== MANIFEST_SCHEMA) throw new TypeError('stored package schema is invalid');
    const revision = requireSha256(
        requireString(value, 'revision', 'stored package metadata'),
        'stored package revision',
    );
    if (requireOwn(value, 'complete', 'stored package metadata') !== true) {
        throw new TypeError('stored package must be complete');
    }
    const source = requireRecord(
        requireOwn(value, 'source', 'stored package metadata'),
        'stored package source',
    );
    const song = requireRecord(
        requireOwn(value, 'song', 'stored package metadata'),
        'stored package song',
    );
    const chart = requireRecord(
        requireOwn(value, 'chart', 'stored package metadata'),
        'stored package chart',
    );
    const audio = requireRecord(
        requireOwn(value, 'audio', 'stored package metadata'),
        'stored package audio',
    );
    const chartMediaType = normalizeMediaType(
        requireString(chart, 'mediaType', 'stored package chart', { nonEmpty: true }),
    );
    const audioMediaType = normalizeMediaType(
        requireString(audio, 'mediaType', 'stored package audio', { nonEmpty: true }),
    );
    if (chartMediaType !== CHART_MEDIA_TYPE || !audioMediaType.startsWith('audio/')) {
        throw new TypeError('stored package artifact media type is invalid');
    }
    if (requireOwn(chart, 'integrityVerified', 'stored package chart') !== true
            || requireOwn(audio, 'integrityVerified', 'stored package audio') !== false) {
        throw new TypeError('stored package integrity state is invalid');
    }
    const chartBytes = requireSafeInteger(
        requireOwn(chart, 'bytes', 'stored package chart'),
        'stored package chart bytes',
        { positive: true },
    );
    if (chartBytes > PRACTICE_PACKAGE_CHART_MAX_BYTES) {
        throw new TypeError('stored package chart exceeds the byte limit');
    }
    return {
        revision,
        schema,
        source: {
            filename: requireString(source, 'filename', 'stored package source', { nonEmpty: true }),
        },
        song: {
            title: requireString(song, 'title', 'stored package song'),
            artist: requireString(song, 'artist', 'stored package song'),
            duration: requireFiniteNumber(
                requireOwn(song, 'duration', 'stored package song'),
                'stored package song duration',
            ),
        },
        arrangement: copyStoredSelection(
            requireOwn(value, 'arrangement', 'stored package metadata'),
        ),
        chart: {
            mediaType: chartMediaType,
            bytes: chartBytes,
            sha256: requireSha256(
                requireString(chart, 'sha256', 'stored package chart'),
                'stored package chart sha256',
            ),
            integrityVerified: true,
        },
        audio: {
            mediaType: audioMediaType,
            bytes: requireSafeInteger(
                requireOwn(audio, 'bytes', 'stored package audio'),
                'stored package audio bytes',
                { positive: true },
            ),
            expectedSha256: requireSha256(
                requireString(audio, 'expectedSha256', 'stored package audio'),
                'stored package audio expectedSha256',
            ),
            integrityVerified: false,
        },
        storedAt: requireSafeInteger(
            requireOwn(value, 'storedAt', 'stored package metadata'),
            'stored package storedAt',
        ),
        complete: true,
    };
}

function copyStoredSelection(record) {
    const value = requireRecord(record, 'stored package arrangement');
    const namingMode = requireString(value, 'namingMode', 'stored package arrangement');
    if (namingMode !== 'legacy' && namingMode !== 'smart') {
        throw new TypeError('stored package namingMode is invalid');
    }
    return {
        index: requireSafeInteger(
            requireOwn(value, 'index', 'stored package arrangement'),
            'stored package arrangement index',
        ),
        name: requireString(value, 'name', 'stored package arrangement'),
        smartName: requireString(value, 'smartName', 'stored package arrangement'),
        namingMode,
        drumPart: copyDrumPart(
            requireOwn(value, 'drumPart', 'stored package arrangement'),
            'stored package arrangement drumPart',
        ),
    };
}

function bytesFromHex(value) {
    const bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < value.length; index += 2) {
        bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
    }
    return bytes;
}

function hexFromBytes(value) {
    return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createPracticePackageStore({
    indexedDB = globalThis.indexedDB,
    getOpfsRoot = () => globalThis.navigator?.storage?.getDirectory?.(),
    requestLock = globalThis.navigator?.locks?.request
        ? globalThis.navigator.locks.request.bind(globalThis.navigator.locks)
        : null,
    crypto = globalThis.crypto,
    FileClass = globalThis.File,
    now = Date.now,
} = {}) {
    let database = null;
    let openingDatabase = null;
    let opfsRoot = null;
    let openingOpfs = null;
    let mutationTail = Promise.resolve();

    function openDatabase() {
        if (database) return Promise.resolve(database);
        if (openingDatabase) return openingDatabase;
        if (!indexedDB || typeof indexedDB.open !== 'function') {
            return Promise.reject(unavailable('IndexedDB is unavailable'));
        }
        openingDatabase = new Promise((resolve, reject) => {
            let settled = false;
            let request;
            const fail = (message, cause) => {
                if (settled) return;
                settled = true;
                reject(unavailable(message, cause));
            };
            try {
                request = indexedDB.open(
                    PRACTICE_PACKAGE_DB_NAME,
                    PRACTICE_PACKAGE_DB_VERSION,
                );
            } catch (error) {
                fail('Unable to open practice-package storage', error);
                return;
            }
            request.onupgradeneeded = () => {
                try {
                    const db = request.result;
                    if (!db.objectStoreNames.contains(PRACTICE_PACKAGE_METADATA_STORE)) {
                        db.createObjectStore(PRACTICE_PACKAGE_METADATA_STORE, {
                            keyPath: 'revision',
                        });
                    }
                } catch (error) {
                    try { request.transaction?.abort(); } catch (_) { /* keep upgrade error */ }
                    fail('Unable to create practice-package storage', error);
                }
            };
            request.onerror = () => fail(
                'Unable to open practice-package storage',
                request.error,
            );
            request.onblocked = () => fail('Opening practice-package storage was blocked');
            request.onsuccess = () => {
                if (settled) {
                    request.result.close();
                    return;
                }
                const db = request.result;
                const hasMetadata = db.objectStoreNames.contains(
                    PRACTICE_PACKAGE_METADATA_STORE,
                );
                if (!hasMetadata) {
                    db.close();
                    fail('Practice-package metadata store is unavailable');
                    return;
                }
                settled = true;
                database = db;
                database.onversionchange = () => {
                    db.close();
                    if (database === db) {
                        database = null;
                        openingDatabase = null;
                    }
                };
                resolve(database);
            };
        }).catch((error) => {
            openingDatabase = null;
            throw error;
        });
        return openingDatabase;
    }

    function openOpfs() {
        if (opfsRoot) return Promise.resolve(opfsRoot);
        if (openingOpfs) return openingOpfs;
        if (typeof getOpfsRoot !== 'function') {
            return Promise.reject(unavailable('OPFS is unavailable'));
        }
        openingOpfs = Promise.resolve().then(() => getOpfsRoot()).then((root) => {
            if (!root || typeof root.getDirectoryHandle !== 'function') {
                throw unavailable('OPFS is unavailable');
            }
            opfsRoot = root;
            return root;
        }).catch((error) => {
            openingOpfs = null;
            throw unavailable('Unable to open practice-package OPFS storage', error);
        });
        return openingOpfs;
    }

    async function open() {
        const [db] = await Promise.all([openDatabase(), openOpfs()]);
        return db;
    }

    function runTransaction(storeNames, mode, operation) {
        return openDatabase().then((db) => new Promise((resolve, reject) => {
            let transaction;
            let values;
            let synchronousError = null;
            let requestError = null;
            let settled = false;
            const fail = (message, cause) => {
                if (settled) return;
                settled = true;
                reject(unavailable(message, cause));
            };
            try {
                transaction = db.transaction(storeNames, mode);
                values = operation(transaction);
            } catch (error) {
                synchronousError = error;
                try { transaction?.abort(); } catch (_) { fail('Practice-package transaction failed', error); }
                if (!transaction) fail('Unable to start a practice-package transaction', error);
            }
            if (!transaction) return;
            transaction.onerror = (event) => {
                if (requestError || !event?.target || event.target === transaction) return;
                try {
                    requestError = event.target.error || null;
                } catch (_) {
                    requestError = null;
                }
            };
            transaction.onabort = () => fail(
                'Practice-package transaction was aborted',
                synchronousError || requestError || transaction.error,
            );
            transaction.oncomplete = () => {
                if (settled) return;
                settled = true;
                resolve(values);
            };
        }));
    }

    async function digestHex(bytes) {
        if (!crypto?.subtle || typeof crypto.subtle.digest !== 'function') {
            throw unavailable('SHA-256 is unavailable');
        }
        try {
            return hexFromBytes(await crypto.subtle.digest('SHA-256', bytes));
        } catch (error) {
            throw unavailable('Unable to calculate package integrity', error);
        }
    }

    function requireArtifactDescriptor(value, label, suppliedArtifacts) {
        const descriptor = requireRecord(value, label);
        const stream = requireOwn(descriptor, 'stream', label);
        if (!stream || typeof stream.pipeTo !== 'function'
                || typeof stream.cancel !== 'function') {
            throw new TypeError(`${label} stream must be a ReadableStream`);
        }
        const artifact = {
            stream,
            mediaType: '',
            piped: false,
            released: false,
        };
        suppliedArtifacts.push(artifact);
        artifact.mediaType = normalizeMediaType(
            requireString(descriptor, 'mediaType', label, { nonEmpty: true }),
        );
        return artifact;
    }

    function requireFile(value, label) {
        if (typeof FileClass !== 'function' || !(value instanceof FileClass)) {
            throw new TypeError(`${label} must be a File`);
        }
        return value;
    }

    function isNotFound(error) {
        return error?.name === 'NotFoundError';
    }

    async function getPackagesDirectory({ create = false } = {}) {
        const root = await openOpfs();
        return root.getDirectoryHandle(
            PRACTICE_PACKAGE_ROOT_DIRECTORY,
            { create },
        );
    }

    async function getRevisionDirectory(revision, { create = false } = {}) {
        const packages = await getPackagesDirectory({ create });
        return packages.getDirectoryHandle(revision, { create });
    }

    async function getSharedAudioDirectory({ create = false } = {}) {
        const packages = await getPackagesDirectory({ create });
        return packages.getDirectoryHandle(
            PRACTICE_PACKAGE_SHARED_AUDIO_DIRECTORY,
            { create },
        );
    }

    function sharedAudioFilename(expectedSha256) {
        return `${expectedSha256}.ogg`;
    }

    async function removeRevisionDirectory(revision) {
        let packages;
        try {
            packages = await getPackagesDirectory();
        } catch (error) {
            if (isNotFound(error)) return;
            throw error;
        }
        try {
            await packages.removeEntry(revision, { recursive: true });
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
    }

    async function cleanupRevision(revision) {
        try {
            await removeRevisionDirectory(revision);
        } catch (_) {
            // Cleanup is best effort so the original write failure remains visible.
        }
    }

    async function removeSharedAudio(expectedSha256) {
        let directory;
        try {
            directory = await getSharedAudioDirectory();
        } catch (error) {
            if (isNotFound(error)) return;
            throw error;
        }
        try {
            await directory.removeEntry(sharedAudioFilename(expectedSha256));
        } catch (error) {
            if (!isNotFound(error)) throw error;
        }
    }

    async function releaseUnusedStream(artifact) {
        if (artifact.piped || artifact.released) return;
        artifact.released = true;
        try {
            await artifact.stream.cancel();
        } catch (_) {
            // Releasing an unused response body must not replace the storage result.
        }
    }

    async function releaseUnusedStreams(artifacts) {
        await Promise.all(artifacts.map(releaseUnusedStream));
    }

    async function writeArtifact(directory, filename, artifact) {
        const handle = await directory.getFileHandle(filename, { create: true });
        const writable = await handle.createWritable();
        artifact.piped = true;
        await artifact.stream.pipeTo(writable);
        return requireFile(await handle.getFile(), `stored ${filename}`);
    }

    function validateFileSize(file, expectedBytes, label) {
        if (file.size !== expectedBytes) {
            throw new TypeError(`${label} byte count does not match the manifest`);
        }
    }

    async function readSharedAudio(metadata) {
        const directory = await getSharedAudioDirectory();
        const handle = await directory.getFileHandle(
            sharedAudioFilename(metadata.audio.expectedSha256),
        );
        const audio = requireFile(await handle.getFile(), 'stored shared audio artifact');
        validateFileSize(audio, metadata.audio.bytes, 'stored shared audio artifact');
        return audio;
    }

    async function readLegacyAudio(metadata) {
        const directory = await getRevisionDirectory(metadata.revision);
        const handle = await directory.getFileHandle(PRACTICE_PACKAGE_AUDIO_FILENAME);
        const audio = requireFile(await handle.getFile(), 'stored audio artifact');
        validateFileSize(audio, metadata.audio.bytes, 'stored audio artifact');
        return audio;
    }

    async function readPackageAudio(metadata) {
        try {
            return await readSharedAudio(metadata);
        } catch (_) {
            return readLegacyAudio(metadata);
        }
    }

    async function readPackageFiles(metadata) {
        try {
            const directory = await getRevisionDirectory(metadata.revision);
            const chartHandle = await directory.getFileHandle(PRACTICE_PACKAGE_CHART_FILENAME);
            const chart = requireFile(await chartHandle.getFile(), 'stored chart artifact');
            const audio = await readPackageAudio(metadata);
            validateFileSize(chart, metadata.chart.bytes, 'stored chart artifact');
            if (await digestHex(await chart.arrayBuffer()) !== metadata.chart.sha256) {
                throw new TypeError('stored chart artifact SHA-256 is invalid');
            }
            return { chart, audio };
        } catch (error) {
            throw unavailable('Stored practice package is incomplete or invalid', error);
        }
    }

    async function listPackages() {
        const request = await runTransaction(
            [PRACTICE_PACKAGE_METADATA_STORE],
            'readonly',
            (transaction) => transaction.objectStore(
                PRACTICE_PACKAGE_METADATA_STORE,
            ).getAll(),
        );
        try {
            return request.result.map(copyStoredMetadata).sort((left, right) => (
                right.storedAt - left.storedAt || left.revision.localeCompare(right.revision)
            ));
        } catch (error) {
            throw unavailable('Stored practice-package metadata is invalid', error);
        }
    }

    async function readPackageMetadata(revision) {
        const key = requireSha256(revision, 'package revision');
        const request = await runTransaction(
            [PRACTICE_PACKAGE_METADATA_STORE],
            'readonly',
            (transaction) => transaction.objectStore(
                PRACTICE_PACKAGE_METADATA_STORE,
            ).get(key),
        );
        if (request.result === undefined) return null;
        try {
            return copyStoredMetadata(request.result);
        } catch (error) {
            throw unavailable('Stored practice-package metadata is invalid', error);
        }
    }

    async function readPackage(revision) {
        const metadata = await readPackageMetadata(revision);
        if (!metadata) return null;
        return { metadata, ...await readPackageFiles(metadata) };
    }

    async function audioReferenceCount(expectedSha256) {
        const request = await runTransaction(
            [PRACTICE_PACKAGE_METADATA_STORE],
            'readonly',
            (transaction) => transaction.objectStore(
                PRACTICE_PACKAGE_METADATA_STORE,
            ).getAll(),
        );
        return request.result.reduce((count, record) => (
            copyStoredMetadata(record).audio.expectedSha256 === expectedSha256
                ? count + 1
                : count
        ), 0);
    }

    async function cleanupUnreferencedSharedAudio(expectedSha256) {
        try {
            if (await audioReferenceCount(expectedSha256) === 0) {
                await removeSharedAudio(expectedSha256);
            }
        } catch (_) {
            // A safe orphan is preferable to deleting an artifact with unknown owners.
        }
    }

    async function writeOrReuseSharedAudio(metadata, audioInput) {
        try {
            const audio = await readSharedAudio(metadata);
            await releaseUnusedStream(audioInput);
            return { audio, created: false };
        } catch (error) {
            if (!isNotFound(error) && !(error instanceof TypeError)) throw error;
            if (error instanceof TypeError
                    && await audioReferenceCount(metadata.audio.expectedSha256) > 0) {
                throw new TypeError('referenced shared audio artifact has an invalid byte count');
            }
        }

        const expectedSha256 = metadata.audio.expectedSha256;
        await removeSharedAudio(expectedSha256);
        let created = false;
        try {
            const directory = await getSharedAudioDirectory({ create: true });
            created = true;
            const audio = await writeArtifact(
                directory,
                sharedAudioFilename(expectedSha256),
                audioInput,
            );
            validateFileSize(audio, metadata.audio.bytes, 'shared audio artifact');
            return { audio, created: true };
        } catch (error) {
            if (created) await cleanupUnreferencedSharedAudio(expectedSha256);
            throw error;
        }
    }

    function queueMutation(operation) {
        const result = mutationTail.then(operation, operation);
        mutationTail = result.catch(() => {});
        return result;
    }

    async function withAudioMutationLock(lockedOperation, fallbackOperation) {
        if (typeof requestLock !== 'function') return fallbackOperation();
        let entered = false;
        try {
            return await requestLock(
                PRACTICE_PACKAGE_AUDIO_LOCK_NAME,
                { mode: 'exclusive' },
                async () => {
                    entered = true;
                    return lockedOperation();
                },
            );
        } catch (error) {
            if (entered) throw error;
            return fallbackOperation();
        }
    }

    async function saveCompletePackageMutation(
        manifest,
        artifacts,
        { storedAt, shareAudio },
    ) {
        const artifactInput = requireRecord(artifacts, 'package artifacts');
        const suppliedArtifacts = [];
        let chartInput;
        let audioInput;
        let descriptor;
        let shouldCleanup = false;
        let createdSharedAudio = false;
        try {
            let descriptorError = null;
            try {
                chartInput = requireArtifactDescriptor(
                    requireOwn(artifactInput, 'chart', 'package artifacts'),
                    'chart artifact',
                    suppliedArtifacts,
                );
            } catch (error) {
                descriptorError = error;
            }
            try {
                audioInput = requireArtifactDescriptor(
                    requireOwn(artifactInput, 'audio', 'package artifacts'),
                    'audio artifact',
                    suppliedArtifacts,
                );
            } catch (error) {
                descriptorError ||= error;
            }
            if (descriptorError) throw descriptorError;
            descriptor = validatePracticePackageManifest(manifest);
            if (chartInput.mediaType !== descriptor.metadata.chart.mediaType) {
                throw new TypeError('chart artifact media type does not match the manifest');
            }
            if (!audioInput.mediaType.startsWith('audio/')) {
                throw new TypeError('audio artifact media type must be audio/*');
            }
            const existing = await readPackageMetadata(descriptor.metadata.revision);
            if (existing) {
                await releaseUnusedStreams(suppliedArtifacts);
                await readPackageFiles(existing);
                return existing;
            }
            const storedTime = requireSafeInteger(
                storedAt === undefined ? now() : storedAt,
                'package storedAt',
            );
            const metadata = {
                ...descriptor.metadata,
                audio: { ...descriptor.metadata.audio, mediaType: audioInput.mediaType },
                storedAt: storedTime,
                complete: true,
            };
            shouldCleanup = true;
            const directory = await getRevisionDirectory(metadata.revision, { create: true });
            const chart = await writeArtifact(
                directory,
                PRACTICE_PACKAGE_CHART_FILENAME,
                chartInput,
            );
            validateFileSize(chart, metadata.chart.bytes, 'chart artifact');
            const chartSha256 = await digestHex(await chart.arrayBuffer());
            if (chartSha256 !== metadata.chart.sha256) {
                throw new TypeError('chart artifact SHA-256 does not match the manifest');
            }
            const revisionBytes = new Uint8Array(64);
            revisionBytes.set(bytesFromHex(chartSha256));
            revisionBytes.set(bytesFromHex(metadata.audio.expectedSha256), 32);
            if (await digestHex(revisionBytes) !== metadata.revision) {
                throw new TypeError('package revision does not match its artifact hashes');
            }
            if (shareAudio) {
                const shared = await writeOrReuseSharedAudio(metadata, audioInput);
                createdSharedAudio = shared.created;
            } else {
                const audio = await writeArtifact(
                    directory,
                    PRACTICE_PACKAGE_AUDIO_FILENAME,
                    audioInput,
                );
                validateFileSize(audio, metadata.audio.bytes, 'audio artifact');
            }
            await runTransaction(
                [PRACTICE_PACKAGE_METADATA_STORE],
                'readwrite',
                (transaction) => transaction.objectStore(
                    PRACTICE_PACKAGE_METADATA_STORE,
                ).put(metadata),
            );
            return copyStoredMetadata(metadata);
        } catch (error) {
            await releaseUnusedStreams(suppliedArtifacts);
            if (shouldCleanup) await cleanupRevision(descriptor.metadata.revision);
            if (createdSharedAudio) {
                await cleanupUnreferencedSharedAudio(descriptor.metadata.audio.expectedSha256);
            }
            if (error instanceof TypeError || error instanceof PracticePackageStoreError) {
                throw error;
            }
            throw unavailable('Unable to store practice-package artifacts', error);
        }
    }

    function saveCompletePackage(manifest, artifacts, options = {}) {
        return queueMutation(() => withAudioMutationLock(
            () => saveCompletePackageMutation(manifest, artifacts, {
                ...options,
                shareAudio: true,
            }),
            () => saveCompletePackageMutation(manifest, artifacts, {
                ...options,
                shareAudio: false,
            }),
        ));
    }

    async function deletePackageMutation(revision, { cleanupSharedAudio }) {
        const key = requireSha256(revision, 'package revision');
        const metadata = await readPackageMetadata(key);
        await runTransaction(
            [PRACTICE_PACKAGE_METADATA_STORE],
            'readwrite',
            (transaction) => transaction.objectStore(
                PRACTICE_PACKAGE_METADATA_STORE,
            ).delete(key),
        );
        let cleanupError = null;
        try {
            await removeRevisionDirectory(key);
        } catch (error) {
            cleanupError = error;
        }
        if (cleanupSharedAudio && metadata) {
            try {
                if (await audioReferenceCount(metadata.audio.expectedSha256) === 0) {
                    await removeSharedAudio(metadata.audio.expectedSha256);
                }
            } catch (error) {
                cleanupError ||= error;
            }
        }
        if (cleanupError) {
            throw unavailable('Unable to delete practice-package artifacts', cleanupError);
        }
    }

    function deletePackage(revision) {
        return queueMutation(() => withAudioMutationLock(
            () => deletePackageMutation(revision, { cleanupSharedAudio: true }),
            () => deletePackageMutation(revision, { cleanupSharedAudio: false }),
        ));
    }

    function close() {
        database?.close();
        database = null;
        openingDatabase = null;
        opfsRoot = null;
        openingOpfs = null;
    }

    return Object.freeze({
        open,
        saveCompletePackage,
        listPackages,
        readPackageMetadata,
        readPackage,
        deletePackage,
        close,
    });
}

const practicePackageStore = createPracticePackageStore();

export const openPracticePackageStore = practicePackageStore.open;
export const saveCompletePracticePackage = practicePackageStore.saveCompletePackage;
export const listCompletePracticePackages = practicePackageStore.listPackages;
export const readCompletePracticePackageMetadata = practicePackageStore.readPackageMetadata;
export const readCompletePracticePackage = practicePackageStore.readPackage;
export const deleteCompletePracticePackage = practicePackageStore.deletePackage;
export const closePracticePackageStore = practicePackageStore.close;
