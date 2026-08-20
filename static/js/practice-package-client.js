import {
    deleteCompletePracticePackage,
    readCompletePracticePackage,
    saveCompletePracticePackage,
    validatePracticePackageManifest,
} from './practice-package-store.js';

export const PRACTICE_PACKAGE_DEFAULT_ARRANGEMENT = -1;
export const PRACTICE_PACKAGE_DEFAULT_NAMING_MODE = 'smart';
export const PRACTICE_PACKAGE_DEFAULT_DRUM_PART = '';

export function buildPracticeManifestUrl({
    filename,
    arrangement = PRACTICE_PACKAGE_DEFAULT_ARRANGEMENT,
    namingMode = PRACTICE_PACKAGE_DEFAULT_NAMING_MODE,
    drumPart = PRACTICE_PACKAGE_DEFAULT_DRUM_PART,
}, baseHref = 'http://localhost/') {
    const url = new URL('/api/practice-package/manifest', baseHref);
    url.searchParams.set('filename', String(filename));
    url.searchParams.set('arrangement', String(arrangement));
    url.searchParams.set('naming_mode', String(namingMode));
    url.searchParams.set('drum_part', String(drumPart));
    return `${url.pathname}${url.search}`;
}

function localArtifactUrl(candidate, kind, locationRef) {
    const url = new URL(candidate, locationRef.href);
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

async function cancelStream(stream) {
    try { await stream?.cancel?.(); } catch {}
}

async function fetchArtifact(url, label, fetchRef) {
    const response = await fetchRef(url, { cache: 'no-store' });
    if (!response.ok) {
        await cancelStream(response.body);
        throw new Error(`${label} fetch failed (${response.status})`);
    }
    if (!response.body || typeof response.body.pipeTo !== 'function') {
        await cancelStream(response.body);
        throw new Error(`${label} response streaming is unavailable`);
    }
    return {
        stream: response.body,
        mediaType: response.headers.get('content-type') || '',
    };
}

async function fetchPracticePackageManifest({
    filename,
    arrangement,
    namingMode,
    drumPart,
    baseHref,
    locationRef,
    fetchRef,
}) {
    const manifestUrl = buildPracticeManifestUrl({
        filename,
        arrangement,
        namingMode,
        drumPart,
    }, baseHref);
    const response = await fetchRef(manifestUrl, { cache: 'no-store' });
    if (!response.ok) {
        await cancelStream(response.body);
        throw new Error(`Manifest fetch failed (${response.status})`);
    }
    const manifest = await response.json();
    const descriptor = validatePracticePackageManifest(manifest);
    return {
        manifest,
        descriptor,
        chartUrl: localArtifactUrl(descriptor.chartUrl, 'Chart', locationRef),
        audioUrl: localArtifactUrl(descriptor.audioUrl, 'Audio', locationRef),
    };
}

function requireArrangementIndexes(value) {
    if (!Array.isArray(value) || value.length === 0) {
        throw new TypeError('arrangementIndexes must be a non-empty array');
    }
    const seen = new Set();
    return value.map((arrangement, index) => {
        if (!Number.isInteger(arrangement)) {
            throw new TypeError(`arrangementIndexes[${index}] must be an integer`);
        }
        if (seen.has(arrangement)) {
            throw new TypeError('arrangementIndexes must not contain duplicates');
        }
        seen.add(arrangement);
        return arrangement;
    });
}

async function cancelArtifacts(artifacts) {
    if (!artifacts) return;
    await Promise.all(Object.values(artifacts).map((artifact) => (
        cancelStream(artifact?.stream)
    )));
}

function attachCleanupErrors(error, cleanupErrors) {
    if (!cleanupErrors.length) return error;
    if (error && (typeof error === 'object' || typeof error === 'function')) {
        try {
            Object.defineProperty(error, 'cleanupErrors', {
                configurable: true,
                enumerable: true,
                value: cleanupErrors,
            });
            return error;
        } catch {}
    }
    return new AggregateError(
        [error, ...cleanupErrors],
        'Practice-package batch failed and cleanup was incomplete',
        { cause: error },
    );
}

function requireMatchingAudio(firstDescriptor, descriptor) {
    const first = firstDescriptor.metadata.audio;
    const current = descriptor.metadata.audio;
    if (current.expectedSha256 !== first.expectedSha256 || current.bytes !== first.bytes) {
        throw new Error('Arrangement manifests do not reference the same full-mix audio');
    }
}

function localAudioArtifact(packageRecord) {
    const audio = packageRecord?.audio;
    if (!audio || typeof audio.stream !== 'function') {
        throw new Error('Stored full-mix audio is unavailable for reuse');
    }
    const stream = audio.stream();
    if (!stream || typeof stream.pipeTo !== 'function' || typeof stream.cancel !== 'function') {
        throw new Error('Stored full-mix audio streaming is unavailable');
    }
    return {
        stream,
        mediaType: packageRecord.metadata.audio.mediaType,
    };
}

export async function fetchPracticePackageArtifacts(
    chartUrl,
    audioUrl,
    { fetch: fetchRef = globalThis.fetch } = {},
) {
    const requests = [
        fetchArtifact(chartUrl, 'Chart', fetchRef),
        fetchArtifact(audioUrl, 'Audio', fetchRef),
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

export async function downloadPracticePackage({
    filename,
    arrangement = PRACTICE_PACKAGE_DEFAULT_ARRANGEMENT,
    namingMode = PRACTICE_PACKAGE_DEFAULT_NAMING_MODE,
    drumPart = PRACTICE_PACKAGE_DEFAULT_DRUM_PART,
    baseHref = globalThis.location?.href || 'http://localhost/',
    locationRef = globalThis.location || new URL(baseHref),
    fetch: fetchRef = globalThis.fetch,
    savePackage = saveCompletePracticePackage,
} = {}) {
    const packageInput = await fetchPracticePackageManifest({
        filename,
        arrangement,
        namingMode,
        drumPart,
        baseHref,
        locationRef,
        fetchRef,
    });
    const [chart, audio] = await fetchPracticePackageArtifacts(
        packageInput.chartUrl,
        packageInput.audioUrl,
        {
            fetch: fetchRef,
        },
    );
    return savePackage(packageInput.manifest, { chart, audio });
}

export async function downloadPracticePackages({
    filename,
    arrangementIndexes,
    namingMode = PRACTICE_PACKAGE_DEFAULT_NAMING_MODE,
    drumPart = PRACTICE_PACKAGE_DEFAULT_DRUM_PART,
    baseHref = globalThis.location?.href || 'http://localhost/',
    locationRef = globalThis.location || new URL(baseHref),
    fetch: fetchRef = globalThis.fetch,
    savePackage = saveCompletePracticePackage,
    readPackage = readCompletePracticePackage,
    deletePackage = deleteCompletePracticePackage,
} = {}) {
    const arrangements = requireArrangementIndexes(arrangementIndexes);
    const storedPackages = [];
    const createdRevisions = [];
    let firstDescriptor = null;
    let storedAudioPackage = null;

    try {
        for (const arrangement of arrangements) {
            const packageInput = await fetchPracticePackageManifest({
                filename,
                arrangement,
                namingMode,
                drumPart,
                baseHref,
                locationRef,
                fetchRef,
            });
            if (firstDescriptor) requireMatchingAudio(firstDescriptor, packageInput.descriptor);

            const revision = packageInput.descriptor.metadata.revision;
            const existedBefore = Boolean(await readPackage(revision));
            let artifacts = null;
            try {
                if (!firstDescriptor) {
                    const [chart, audio] = await fetchPracticePackageArtifacts(
                        packageInput.chartUrl,
                        packageInput.audioUrl,
                        { fetch: fetchRef },
                    );
                    artifacts = { chart, audio };
                } else {
                    const chart = await fetchArtifact(
                        packageInput.chartUrl,
                        'Chart',
                        fetchRef,
                    );
                    artifacts = { chart };
                    artifacts.audio = localAudioArtifact(storedAudioPackage);
                }

                const metadata = await savePackage(packageInput.manifest, artifacts);
                artifacts = null;
                storedPackages.push(metadata);
                if (!existedBefore && !createdRevisions.includes(metadata.revision)) {
                    createdRevisions.push(metadata.revision);
                }

                if (!firstDescriptor) {
                    firstDescriptor = packageInput.descriptor;
                    storedAudioPackage = await readPackage(metadata.revision);
                    if (!storedAudioPackage) {
                        throw new Error('Stored first arrangement could not be reopened');
                    }
                }
            } catch (error) {
                await cancelArtifacts(artifacts);
                throw error;
            }
        }
        return storedPackages;
    } catch (error) {
        const cleanupErrors = [];
        for (let index = createdRevisions.length - 1; index >= 0; index -= 1) {
            const revision = createdRevisions[index];
            try {
                await deletePackage(revision);
            } catch (cleanupError) {
                cleanupErrors.push({ revision, error: cleanupError });
            }
        }
        throw attachCleanupErrors(error, cleanupErrors);
    }
}
