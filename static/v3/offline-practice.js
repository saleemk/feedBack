import {
    closePracticePackageStore,
    deleteCompletePracticePackage,
    listCompletePracticePackages,
    openPracticePackageStore,
} from '../js/practice-package-store.js';
import {
    downloadPracticePackage,
    downloadPracticePackages,
} from '../js/practice-package-client.js';
import {
    cacheOfflineArtwork,
    deleteOfflineArtwork,
} from '../js/offline-artwork-cache.js';
import { playOfflinePracticePackage } from '../js/session.js';

const TOOLBAR_ID = 'v3-songs-offline';
const PANEL_ID = 'v3-offline-panel';
const DOWNLOAD_ACTION_ID = 'offline-download';
const OPEN_ACTION_ID = 'offline-open';
const DELETE_ACTION_ID = 'offline-delete';
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function formatBytes(value) {
    if (!Number.isFinite(value)) return 'Unavailable';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDate(value) {
    if (!Number.isFinite(value)) return 'Date unavailable';
    try { return new Date(value).toLocaleString(); } catch { return 'Date unavailable'; }
}

function packageLabel(metadata) {
    return `${metadata.song.artist} - ${metadata.song.title}`;
}

function packageBytes(metadata) {
    return (metadata?.chart?.bytes || 0) + (metadata?.audio?.bytes || 0);
}

function decodeFilename(value) {
    if (typeof value !== 'string' || value.indexOf('%') === -1) return value || '';
    try { return decodeURIComponent(value); } catch { return value; }
}

function compareText(left, right) {
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
}

function comparePackages(left, right) {
    return left.arrangement.index - right.arrangement.index
        || compareText(left.revision, right.revision);
}

function groupCompletePackages(packages) {
    const byFilename = new Map();
    for (const metadata of Array.isArray(packages) ? packages : []) {
        const filename = decodeFilename(metadata?.source?.filename);
        if (!metadata?.complete || !filename || !metadata.revision
                || !Number.isInteger(metadata.arrangement?.index)) continue;
        if (!byFilename.has(filename)) byFilename.set(filename, []);
        byFilename.get(filename).push(metadata);
    }
    return Array.from(byFilename, ([filename, entries]) => {
        entries.sort(comparePackages);
        return {
            filename,
            packages: entries,
            metadata: entries[0],
            bytes: entries.reduce((total, metadata) => total + packageBytes(metadata), 0),
        };
    }).sort((left, right) => compareText(left.filename, right.filename));
}

function defaultConfirm({ title, html, confirmText, danger = false }, windowRef) {
    if (typeof windowRef.uiConfirm === 'function') {
        return windowRef.uiConfirm({ title, html, confirmText, cancelText: 'Cancel', danger });
    }
    return Promise.resolve(windowRef.confirm(
        `${title}\n\n${html.replace(/<[^>]+>/g, '')}`,
    ));
}

function notify(windowRef, title, message, icon = '↓', accent = '#22C55E') {
    try {
        windowRef.fbNotify?.show({ title, message, icon, accent });
    } catch {}
}

export function createOfflinePracticeController({
    document: documentRef = globalThis.document,
    window: windowRef = globalThis.window || globalThis,
    navigator: navigatorRef = globalThis.navigator,
    location: locationRef = globalThis.location,
    store = {
        open: openPracticePackageStore,
        listPackages: listCompletePracticePackages,
        deletePackage: deleteCompletePracticePackage,
        close: closePracticePackageStore,
    },
    download = downloadPracticePackage,
    downloadMany = downloadPracticePackages,
    artwork = {
        capture: cacheOfflineArtwork,
        remove: deleteOfflineArtwork,
    },
    launch = playOfflinePracticePackage,
    confirm = (options) => defaultConfirm(options, windowRef),
} = {}) {
    let packages = [];
    let storageReady = false;
    let storageReadiness = null;
    let busy = false;
    const busyGroups = new Set();
    let actionUnregister = null;
    let libraryWindowListener = null;
    let observer = null;
    let offlineFilenames = new Set();
    const liveSongs = new Map();

    function toolbar() {
        return documentRef?.getElementById('v3-songs-toolbar');
    }

    function libraryRoot() {
        return documentRef?.getElementById('v3-songs');
    }

    function updateCount() {
        const button = documentRef?.getElementById(TOOLBAR_ID);
        if (!button) return;
        button.textContent = `Offline (${groupCompletePackages(packages).length})`;
    }

    function rebuildOfflineFilenames() {
        const next = new Set();
        groupCompletePackages(packages).forEach((group) => {
            next.add(group.filename);
        });
        offlineFilenames = next;
    }

    function cardHasOfflinePackage(card) {
        const filename = card?.getAttribute?.('data-fn');
        return !!filename && (offlineFilenames.has(filename) || offlineFilenames.has(decodeFilename(filename)));
    }

    function packagesForSong(song) {
        const filename = decodeFilename(song?.filename);
        if (!filename) return [];
        return groupCompletePackages(packages)
            .find((group) => group.filename === filename)?.packages || [];
    }

    function eligibleArrangements(song) {
        if (!Array.isArray(song?.arrangements)) return [];
        const seen = new Set();
        return song.arrangements.reduce((eligible, arrangement) => {
            const index = arrangement?.index;
            if (!Number.isFinite(index) || !Number.isInteger(index) || seen.has(index)) return eligible;
            seen.add(index);
            eligible.push({
                index,
                name: typeof arrangement.name === 'string' && arrangement.name.trim()
                    ? arrangement.name.trim()
                    : null,
            });
            return eligible;
        }, []);
    }

    function missingArrangements(song) {
        const stored = new Set(packagesForSong(song).map((metadata) => (
            metadata?.arrangement?.index
        )).filter(Number.isInteger));
        return eligibleArrangements(song).filter((arrangement) => !stored.has(arrangement.index));
    }

    function rememberSong(song) {
        if (song?.filename) liveSongs.set(decodeFilename(song.filename), song);
        return song;
    }

    function canUseOfflineActions(song) {
        return song?.provider === 'local' && !!song?.filename;
    }

    function captureArtworkDetached(filename) {
        void Promise.resolve()
            .then(() => artwork.capture(filename))
            .catch(() => {});
    }

    function decorateVisibleCards() {
        const visibleCards = windowRef.v3Songs?.visibleCards;
        if (typeof visibleCards !== 'function') return;
        let cards;
        try { cards = Array.from(visibleCards.call(windowRef.v3Songs)); } catch { return; }
        cards.forEach((card) => {
            const badge = card.querySelector?.('[data-v3-format-badge]');
            if (!badge) return;
            if (!badge.dataset.offlineOriginalText) {
                badge.dataset.offlineOriginalText = badge.textContent || '';
                badge.dataset.offlineOriginalTitle = badge.title || '';
                badge.dataset.offlineOriginalClass = badge.className || '';
            }
            if (cardHasOfflinePackage(card)) {
                badge.textContent = 'OFFLINE';
                const filename = card.getAttribute?.('data-fn');
                const song = liveSongs.get(decodeFilename(filename));
                const eligible = eligibleArrangements(song);
                if (eligible.length) {
                    const eligibleIndexes = new Set(eligible.map((arrangement) => arrangement.index));
                    const storedIndexes = new Set(packagesForSong(song).map((metadata) => (
                        metadata?.arrangement?.index
                    )).filter((index) => eligibleIndexes.has(index)));
                    badge.title = `${storedIndexes.size} of ${eligible.length} arrangements stored for offline practice`;
                } else {
                    badge.title = 'Stored for offline practice';
                }
                badge.className = String(badge.dataset.offlineOriginalClass || badge.className || '')
                    .replace(/\bbg-fb-primary\b/g, 'bg-amber-400')
                    .replace(/\btext-white\b/g, 'text-black');
                return;
            }
            badge.textContent = badge.dataset.offlineOriginalText || '';
            badge.title = badge.dataset.offlineOriginalTitle || '';
            badge.className = badge.dataset.offlineOriginalClass || badge.className || '';
        });
    }

    function setPanelExpanded(expanded) {
        documentRef?.getElementById(TOOLBAR_ID)?.setAttribute(
            'aria-expanded',
            expanded ? 'true' : 'false',
        );
    }

    function closePanel(panel) {
        panel.remove();
        setPanelExpanded(false);
    }

    async function storageEstimate() {
        const storage = navigatorRef?.storage;
        if (!storage || typeof storage.estimate !== 'function') return null;
        try {
            const estimate = await storage.estimate();
            return {
                usage: Number(estimate.usage),
                quota: Number(estimate.quota),
            };
        } catch { return null; }
    }

    function panelMarkup(estimate) {
        const groups = groupCompletePackages(packages);
        const totalBytes = groups.reduce((sum, group) => sum + group.bytes, 0);
        const summary = `${groups.length} offline ${groups.length === 1 ? 'song' : 'songs'} · ${formatBytes(totalBytes)} used`;
        const hasQuota = estimate && Number.isFinite(estimate.usage)
            && Number.isFinite(estimate.quota) && estimate.quota > 0;
        const quotaPct = hasQuota ? Math.max(0, Math.min(100, (estimate.usage / estimate.quota) * 100)) : 0;
        const fillPct = hasQuota && estimate.usage > 0 ? Math.max(5, quotaPct) : quotaPct;
        const quotaTitle = hasQuota
            ? 'Storage usage: ' + formatBytes(estimate.usage) + ' used / '
                + formatBytes(estimate.quota) + ' quota (' + quotaPct.toFixed(1) + '%)'
            : '';
        const quotaBar = hasQuota
            ? '<div class="mt-2 h-2 overflow-hidden rounded-full border border-fb-border/60 bg-fb-card/80" title="' + esc(quotaTitle) +
                '" role="meter" aria-label="' + esc(quotaTitle) + '" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' +
                esc(quotaPct.toFixed(1)) + '"><div class="h-full rounded-full bg-amber-300" style="width:' +
                esc(fillPct.toFixed(1)) + '%"></div></div>'
            : '';
        const rows = groups.length
            ? groups.map((group) => {
                const metadata = group.metadata;
                const count = group.packages.length;
                return '<li class="flex items-center justify-between gap-2 border-t border-fb-border/40 py-2">' +
                    '<div class="min-w-0"><div class="truncate text-sm font-medium text-fb-text">' +
                    esc(packageLabel(metadata)) + '</div><div class="truncate text-xs text-fb-textDim">' +
                    count + ' stored ' + (count === 1 ? 'arrangement' : 'arrangements') + ' · ' + formatBytes(group.bytes) +
                    '<span class="hidden sm:inline"> · ' + esc(formatDate(metadata.storedAt)) + '</span></div></div>' +
                    '<div class="flex shrink-0 gap-1.5"><button type="button" data-offline-play="' + esc(metadata.revision) +
                    '" class="rounded-md border border-fb-accent/60 px-2 py-1 text-xs text-fb-text">Open</button>' +
                    '<button type="button" data-offline-delete="' + esc(metadata.revision) +
                    '" class="rounded-md border border-fb-border/60 px-2 py-1 text-xs text-fb-text">Delete</button></div></li>';
            }).join('')
            : '<li class="border-t border-fb-border/40 py-2 text-sm text-fb-textDim">No offline downloads yet. Use a song-card More menu to add one.</li>';
        return '<section id="' + PANEL_ID + '" class="mb-4 border-y border-fb-border/50 bg-fb-sidebar/80 px-3 py-2.5 sm:px-4" aria-labelledby="v3-offline-heading">' +
            '<div class="flex items-start justify-between gap-3"><div class="min-w-0"><h2 id="v3-offline-heading" class="text-sm font-semibold text-fb-text">Offline practice</h2>' +
            '<p class="mt-0.5 text-xs text-fb-textDim">' + esc(summary) + '</p>' + quotaBar + '</div>' +
            '<button type="button" data-offline-close class="shrink-0 text-xs text-fb-textDim">Close</button></div>' +
            '<ul class="mt-2">' + rows + '</ul></section>';
    }

    function bindPanel(panel) {
        panel.querySelector('[data-offline-close]')?.addEventListener('click', () => closePanel(panel));
        panel.querySelectorAll('[data-offline-play]').forEach((button) => {
            button.addEventListener('click', async () => {
                const revision = button.getAttribute('data-offline-play');
                const group = groupCompletePackages(packages)
                    .find((entry) => entry.metadata.revision === revision);
                if (group) await openStoredGroup(group);
            });
        });
        panel.querySelectorAll('[data-offline-delete]').forEach((button) => {
            button.addEventListener('click', async () => {
                const revision = button.getAttribute('data-offline-delete');
                const group = groupCompletePackages(packages)
                    .find((entry) => entry.metadata.revision === revision);
                if (group) await deleteStoredGroup(group);
            });
        });
    }

    async function openStoredGroup(group) {
        const key = group?.filename;
        const metadata = group?.metadata;
        if (!key || !metadata || busyGroups.has(key)) return;
        busyGroups.add(key);
        try {
            await launch(metadata.revision);
            notify(windowRef, 'Offline practice ready', packageLabel(metadata));
            const current = documentRef?.getElementById(PANEL_ID);
            if (current) closePanel(current);
        } catch (error) {
            notify(windowRef, 'Offline launch failed', error.message || String(error), '!', '#EF4444');
            try { await refresh(); } catch (_) {}
        } finally { busyGroups.delete(key); }
    }

    async function deleteStoredGroup(group) {
        const key = group?.filename;
        const stored = group?.packages || [];
        if (!key || !stored.length || busyGroups.has(key)) return;
        const label = packageLabel(group.metadata);
        busyGroups.add(key);
        let ok = false;
        try {
            ok = await confirm({
                title: stored.length === 1 ? 'Delete offline bundle?' : 'Delete offline arrangements?',
                html: 'Delete ' + stored.length + ' stored offline ' +
                    (stored.length === 1 ? 'arrangement' : 'arrangements') + ' for <strong>' +
                    esc(label) + '</strong>?',
                confirmText: stored.length === 1 ? 'Delete bundle' : 'Delete arrangements',
                danger: true,
            });
        } catch (error) {
            notify(windowRef, 'Offline delete failed', error.message || String(error), '!', '#EF4444');
            busyGroups.delete(key);
            return;
        }
        if (!ok) {
            busyGroups.delete(key);
            return;
        }
        let failure = null;
        try {
            for (const metadata of stored) {
                try { await store.deletePackage(metadata.revision); } catch (error) { failure ||= error; }
            }
            try { await refresh(); } catch (error) { failure ||= error; }
            if (!groupCompletePackages(packages).some((entry) => entry.filename === key)) {
                try { await artwork.remove(key); } catch (error) { failure ||= error; }
            }
            if (failure) {
                notify(windowRef, stored.length === 1 ? 'Offline delete failed' : 'Offline delete incomplete',
                    failure.message || String(failure), '!', '#EF4444');
            } else {
                notify(windowRef, stored.length === 1 ? 'Offline bundle deleted' : 'Offline arrangements deleted', label, '×');
            }
        } finally { busyGroups.delete(key); }
    }

    async function openOfflineSong(song) {
        rememberSong(song);
        const stored = packagesForSong(song);
        if (!stored.length) return;
        await openStoredGroup({
            filename: decodeFilename(song.filename),
            packages: stored,
            metadata: stored[0],
        });
    }

    async function deleteOfflineSong(song) {
        rememberSong(song);
        const stored = packagesForSong(song);
        if (!stored.length) return;
        await deleteStoredGroup({
            filename: decodeFilename(song.filename),
            packages: stored,
            metadata: stored[0],
        });
    }

    async function synchronizePackages() {
        packages = await store.listPackages();
        const groups = groupCompletePackages(packages);
        groups.forEach((group) => captureArtworkDetached(group.filename));
        rebuildOfflineFilenames();
        updateCount();
        decorateVisibleCards();
        const panel = documentRef?.getElementById(PANEL_ID);
        if (panel) {
            panel.outerHTML = panelMarkup(await storageEstimate());
            bindPanel(documentRef.getElementById(PANEL_ID));
        }
        return packages;
    }

    async function ensureStorageReady() {
        if (storageReady) return packages;
        if (storageReadiness) return storageReadiness;
        storageReadiness = (async () => {
            await store.open();
            const synchronized = await synchronizePackages();
            storageReady = true;
            return synchronized;
        })();
        try {
            return await storageReadiness;
        } catch (error) {
            storageReady = false;
            throw error;
        } finally {
            storageReadiness = null;
        }
    }

    async function refresh() {
        if (!storageReady) return ensureStorageReady();
        return synchronizePackages();
    }

    async function showPanel(toggle = true) {
        await refresh();
        const current = documentRef.getElementById(PANEL_ID);
        if (current) {
            if (toggle) closePanel(current);
            return;
        }
        const target = toolbar();
        if (!target) return;
        target.insertAdjacentHTML('afterend', panelMarkup(await storageEstimate()));
        bindPanel(documentRef.getElementById(PANEL_ID));
        setPanelExpanded(true);
    }

    async function downloadSong(song) {
        if (!song?.filename || busy) return;
        rememberSong(song);
        try {
            await ensureStorageReady();
        } catch (error) {
            notify(windowRef, 'Offline storage unavailable', error.message || String(error), '!', '#EF4444');
            return;
        }
        const existing = packagesForSong(song);
        const eligible = eligibleArrangements(song);
        const missing = missingArrangements(song);
        if (eligible.length && !missing.length) {
            notify(windowRef, 'Offline arrangements already stored', packageLabel(existing[0]));
            return;
        }
        if (!eligible.length && existing.length) {
            notify(windowRef, 'Offline bundle already stored', packageLabel(existing[0]));
            return;
        }
        const label = packageLabel({ song: {
            artist: song.artist || 'Unknown artist',
            title: song.title || song.filename,
        }});
        const batch = eligible.length > 0;
        const arrangementNames = missing.map((arrangement) => arrangement.name).filter(Boolean);
        const ok = await confirm(batch ? {
            title: `Download ${missing.length} ${missing.length === 1 ? 'arrangement' : 'arrangements'} for offline practice?`,
            html: 'Download <strong>' + esc(label) + '</strong> for later use?' +
                (arrangementNames.length
                    ? '<p class="mt-2 text-xs text-fb-textDim">' + esc(arrangementNames.join(', ')) + '</p>'
                    : ''),
            confirmText: 'Download',
        } : {
            title: 'Download for offline practice?',
            html: 'Download <strong>' + esc(label) + '</strong> for later use?' +
                '<p class="mt-2 text-xs text-fb-textDim">This stores the full mix and the default chart for offline practice.</p>',
            confirmText: 'Download',
        });
        if (!ok) return;
        busy = true;
        try {
            const options = {
                filename: song.filename,
                baseHref: locationRef.href,
                locationRef,
            };
            const result = batch
                ? await downloadMany({ ...options, arrangementIndexes: missing.map((arrangement) => arrangement.index) })
                : await download(options);
            captureArtworkDetached(song.filename);
            await refresh();
            const metadata = Array.isArray(result) ? result[0] : result;
            notify(windowRef, batch ? 'Offline arrangements stored' : 'Offline bundle stored',
                metadata ? packageLabel(metadata) : label);
        } catch (error) {
            notify(windowRef, 'Offline download failed', error.message || String(error), '!', '#EF4444');
        } finally { busy = false; }
    }

    function registerAction() {
        const registry = windowRef.feedBack?.libraryCardActions;
        if (!registry || actionUnregister) return;
        const unregisters = [
            registry.register({
                id: DOWNLOAD_ACTION_ID,
                pluginId: 'core.offline-practice',
                label: 'Download for offline practice',
                icon: '↓',
                placement: 'menu',
                order: 35,
                applies: (song) => {
                    rememberSong(song);
                    if (!canUseOfflineActions(song)) return false;
                    const eligible = eligibleArrangements(song);
                    return eligible.length ? missingArrangements(song).length > 0 : packagesForSong(song).length === 0;
                },
                enabled: (song) => !busy && !busyGroups.has(decodeFilename(song?.filename)),
                run: downloadSong,
            }),
            registry.register({
                id: OPEN_ACTION_ID,
                pluginId: 'core.offline-practice',
                label: 'Open offline',
                icon: '▶',
                placement: 'menu',
                order: 35,
                applies: (song) => canUseOfflineActions(rememberSong(song)) && packagesForSong(song).length > 0,
                enabled: (song) => !busy && !busyGroups.has(decodeFilename(song?.filename)),
                run: openOfflineSong,
            }),
            registry.register({
                id: DELETE_ACTION_ID,
                pluginId: 'core.offline-practice',
                label: 'Remove download',
                icon: '×',
                placement: 'menu',
                order: 36,
                destructive: true,
                applies: (song) => canUseOfflineActions(rememberSong(song)) && packagesForSong(song).length > 0,
                enabled: (song) => !busy && !busyGroups.has(decodeFilename(song?.filename)),
                run: deleteOfflineSong,
            }),
        ];
        actionUnregister = () => unregisters.forEach((unregister) => unregister?.());
    }

    function ensureToolbar() {
        const target = toolbar();
        if (!target || documentRef.getElementById(TOOLBAR_ID)) return;
        const controls = target.lastElementChild?.lastElementChild || target;
        const button = documentRef.createElement('button');
        button.id = TOOLBAR_ID;
        button.type = 'button';
        button.className = 'bg-gray-800/50 border border-gray-700 rounded-md px-3 py-2 text-sm text-fb-text';
        button.setAttribute('aria-expanded', 'false');
        button.addEventListener('click', async () => {
            try { await showPanel(); } catch (error) {
                notify(windowRef, 'Offline storage unavailable', error.message || String(error), '!', '#EF4444');
            }
        });
        controls.appendChild(button);
        updateCount();
    }

    function observeLibrary() {
        ensureToolbar();
        const root = libraryRoot();
        if (!root || typeof MutationObserver !== 'function' || observer) return;
        observer = new MutationObserver(() => ensureToolbar());
        observer.observe(root, { childList: true });
    }

    function observeLibraryWindow() {
        if (libraryWindowListener) return;
        const bus = windowRef.feedBack;
        if (!bus || typeof bus.on !== 'function') return;
        libraryWindowListener = () => decorateVisibleCards();
        bus.on('v3:library-window-rendered', libraryWindowListener);
    }

    async function start() {
        registerAction();
        observeLibrary();
        observeLibraryWindow();
        try {
            await ensureStorageReady();
        } catch (error) {
            return { ready: false, error };
        }
        return { ready: true, packages };
    }

    function destroy() {
        observer?.disconnect();
        observer = null;
        actionUnregister?.();
        actionUnregister = null;
        if (libraryWindowListener && windowRef.feedBack?.off) {
            windowRef.feedBack.off('v3:library-window-rendered', libraryWindowListener);
        }
        libraryWindowListener = null;
        store.close();
    }

    return Object.freeze({ start, refresh, destroy, downloadSong });
}

if (globalThis.document) {
    void createOfflinePracticeController().start();
}
