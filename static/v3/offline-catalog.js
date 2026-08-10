import { readDeviceCatalogSnapshot } from '../js/device-catalog.js';

const songCollator = new Intl.Collator('en', { sensitivity: 'base' });

function compareSongs(left, right) {
    return songCollator.compare(left.artist, right.artist)
        || songCollator.compare(left.title, right.title)
        || left.id.localeCompare(right.id);
}

export function sortOfflineSongs(songs) {
    return songs.slice().sort(compareSongs);
}

export function filterOfflineSongs(songs, query) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return songs.slice();
    return songs.filter((song) => (
        song.title.toLowerCase().includes(needle)
        || song.artist.toLowerCase().includes(needle)
    ));
}

function defaultFormatCapturedAt(capturedAt) {
    try {
        return new Intl.DateTimeFormat(undefined, {
            dateStyle: 'medium',
            timeStyle: 'short',
        }).format(new Date(capturedAt));
    } catch (_) {
        return 'Capture time unavailable';
    }
}

function songCountLabel(count) {
    return `${count} ${count === 1 ? 'song' : 'songs'}`;
}

export function createOfflineCatalog({
    document: documentRef = globalThis.document,
    readSnapshot = readDeviceCatalogSnapshot,
    formatCapturedAt = defaultFormatCapturedAt,
} = {}) {
    let startPromise = null;
    let songs = [];

    function element(id) {
        const target = documentRef?.getElementById(id);
        if (!target) throw new Error(`Missing offline catalog element: ${id}`);
        return target;
    }

    function showView(view) {
        if (view !== 'home' && view !== 'library') return;
        const home = element('offline-home');
        const library = element('offline-library');
        const homeButton = element('offline-nav-home');
        const libraryButton = element('offline-nav-library');
        const showHome = view === 'home';
        home.hidden = !showHome;
        library.hidden = showHome;
        if (showHome) homeButton.setAttribute('aria-current', 'page');
        else homeButton.removeAttribute('aria-current');
        if (!showHome) libraryButton.setAttribute('aria-current', 'page');
        else libraryButton.removeAttribute('aria-current');
    }

    function renderLibrary(query = '') {
        const visibleSongs = filterOfflineSongs(songs, query);
        const list = element('offline-song-list');
        const resultCount = element('offline-result-count');
        const empty = element('offline-library-empty');
        list.replaceChildren();

        for (const song of visibleSongs) {
            const row = documentRef.createElement('li');
            row.className = 'song-row';
            const title = documentRef.createElement('span');
            title.className = 'song-title';
            title.textContent = song.title;
            const artist = documentRef.createElement('span');
            artist.className = 'song-artist';
            artist.textContent = song.artist;
            row.append(title, artist);
            list.append(row);
        }

        resultCount.textContent = `${songCountLabel(visibleSongs.length)} of ${songCountLabel(songs.length)}`;
        empty.hidden = visibleSongs.length !== 0;
        empty.textContent = songs.length === 0
            ? 'No songs were captured on this device.'
            : 'No songs match your search.';
    }

    async function initialize() {
        try {
            const snapshot = await readSnapshot();
            if (!snapshot) return false;
            songs = sortOfflineSongs(snapshot.songs);

            element('offline-song-count').textContent = `${songCountLabel(snapshot.metadata.count)} available`;
            element('offline-captured-at').textContent = `Captured ${formatCapturedAt(
                snapshot.metadata.capturedAt,
            )}`;
            const search = element('offline-search');
            search.addEventListener('input', () => renderLibrary(search.value));
            element('offline-nav-home').addEventListener('click', () => showView('home'));
            element('offline-nav-library').addEventListener('click', () => showView('library'));
            element('offline-browse-library').addEventListener('click', () => showView('library'));

            renderLibrary();
            showView('home');
            element('offline-recovery').hidden = true;
            element('offline-app').hidden = false;
            return true;
        } catch (_) {
            return false;
        }
    }

    function start() {
        if (!startPromise) startPromise = initialize();
        return startPromise;
    }

    return Object.freeze({ start, showView });
}

function boot() {
    void createOfflineCatalog().start();
}

if (globalThis.document) {
    if (globalThis.document.readyState === 'loading') {
        globalThis.document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
}
