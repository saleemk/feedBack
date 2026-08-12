import {
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

async function fetchArtifact(url, label, fetchRef) {
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
    const manifestUrl = buildPracticeManifestUrl({
        filename,
        arrangement,
        namingMode,
        drumPart,
    }, baseHref);
    const manifestResponse = await fetchRef(manifestUrl, { cache: 'no-store' });
    if (!manifestResponse.ok) {
        throw new Error(`Manifest fetch failed (${manifestResponse.status})`);
    }
    const manifest = await manifestResponse.json();
    const descriptor = validatePracticePackageManifest(manifest);
    const chartUrl = localArtifactUrl(descriptor.chartUrl, 'Chart', locationRef);
    const audioUrl = localArtifactUrl(descriptor.audioUrl, 'Audio', locationRef);
    const [chart, audio] = await fetchPracticePackageArtifacts(chartUrl, audioUrl, {
        fetch: fetchRef,
    });
    return savePackage(manifest, { chart, audio });
}
