import {
    closePracticePackageStore,
    deleteCompletePracticePackage,
    listCompletePracticePackages,
    openPracticePackageStore,
} from '../js/practice-package-store.js';
import { downloadPracticePackage } from '../js/practice-package-client.js';
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

function downloadsLabel(count) {
    return `${count} ${count === 1 ? 'download' : 'downloads'}`;
}

function decodeFilename(value) {
    if (typeof value !== 'string' || value.indexOf('%') === -1) return value || '';
    try { return decodeURIComponent(value); } catch { return value; }
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
    launch = playOfflinePracticePackage,
    confirm = (options) => defaultConfirm(options, windowRef),
} = {}) {
    let packages = [];
    let storageReady = false;
    let storageReadiness = null;
    let busy = false;
    let actionUnregister = null;
    let libraryWindowListener = null;
    let observer = null;
    let offlineFilenames = new Set();

    function toolbar() {
        return documentRef?.getElementById('v3-songs-toolbar');
    }

    function libraryRoot() {
        return documentRef?.getElementById('v3-songs');
    }

    function updateCount() {
        const button = documentRef?.getElementById(TOOLBAR_ID);
        if (button) button.textContent = `Offline (${packages.length})`;
    }

    function rebuildOfflineFilenames() {
        const next = new Set();
        packages.forEach((metadata) => {
            const filename = metadata?.source?.filename;
            if (!filename) return;
            next.add(filename);
            next.add(decodeFilename(filename));
        });
        offlineFilenames = next;
    }

    function cardHasOfflinePackage(card) {
        const filename = card?.getAttribute?.('data-fn');
        return !!filename && (offlineFilenames.has(filename) || offlineFilenames.has(decodeFilename(filename)));
    }

    function packageForSong(song) {
        const filename = song?.filename;
        if (!filename) return null;
        const decoded = decodeFilename(filename);
        return packages.find((metadata) => {
            const stored = metadata?.source?.filename;
            return stored && (stored === filename || stored === decoded || decodeFilename(stored) === decoded);
        }) || null;
    }

    function canUseOfflineActions(song) {
        return song?.provider === 'local' && !!song?.filename;
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
                badge.title = 'Stored for offline practice';
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
        const totalBytes = packages.reduce((sum, metadata) => sum + packageBytes(metadata), 0);
        const summary = downloadsLabel(packages.length) + ' · ' + formatBytes(totalBytes) + ' used';
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
        const rows = packages.length
            ? packages.map((metadata) => {
                const bytes = packageBytes(metadata);
                return '<li class="flex items-center justify-between gap-2 border-t border-fb-border/40 py-2">' +
                    '<div class="min-w-0"><div class="truncate text-sm font-medium text-fb-text">' +
                    esc(packageLabel(metadata)) + '</div><div class="truncate text-xs text-fb-textDim">' +
                    esc(metadata.arrangement.name) + ' · ' + formatBytes(bytes) +
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
                const metadata = packages.find((entry) => entry.revision === revision);
                if (!metadata || busy) return;
                busy = true;
                try {
                    await launch(revision);
                    notify(windowRef, 'Offline practice ready', packageLabel(metadata));
                    const current = documentRef?.getElementById(PANEL_ID);
                    if (current) closePanel(current);
                } catch (error) {
                    notify(windowRef, 'Offline launch failed', error.message || String(error), '!', '#EF4444');
                    try { await refresh(); } catch (_) {}
                } finally { busy = false; }
            });
        });
        panel.querySelectorAll('[data-offline-delete]').forEach((button) => {
            button.addEventListener('click', async () => {
                const revision = button.getAttribute('data-offline-delete');
                const metadata = packages.find((entry) => entry.revision === revision);
                if (!metadata || busy) return;
                const ok = await confirm({
                    title: 'Delete offline bundle?',
                    html: 'Delete the stored full mix and default chart for <strong>' +
                        esc(packageLabel(metadata)) + '</strong>?',
                    confirmText: 'Delete bundle',
                    danger: true,
                });
                if (!ok) return;
                busy = true;
                try {
                    await store.deletePackage(revision);
                    await refresh();
                    notify(windowRef, 'Offline bundle deleted', packageLabel(metadata), '×');
                } catch (error) {
                    notify(windowRef, 'Offline delete failed', error.message || String(error), '!', '#EF4444');
                } finally { busy = false; }
            });
        });
    }

    async function openOfflineSong(song) {
        const metadata = packageForSong(song);
        if (!metadata || busy) return;
        busy = true;
        try {
            await launch(metadata.revision);
            notify(windowRef, 'Offline practice ready', packageLabel(metadata));
            const current = documentRef?.getElementById(PANEL_ID);
            if (current) closePanel(current);
        } catch (error) {
            notify(windowRef, 'Offline launch failed', error.message || String(error), '!', '#EF4444');
            try { await refresh(); } catch (_) {}
        } finally { busy = false; }
    }

    async function deleteOfflineSong(song) {
        const metadata = packageForSong(song);
        if (!metadata || busy) return;
        const ok = await confirm({
            title: 'Delete offline bundle?',
            html: 'Delete the stored full mix and default chart for <strong>' +
                esc(packageLabel(metadata)) + '</strong>?',
            confirmText: 'Delete bundle',
            danger: true,
        });
        if (!ok) return;
        busy = true;
        try {
            await store.deletePackage(metadata.revision);
            await refresh();
            notify(windowRef, 'Offline bundle deleted', packageLabel(metadata), '×');
        } catch (error) {
            notify(windowRef, 'Offline delete failed', error.message || String(error), '!', '#EF4444');
        } finally { busy = false; }
    }

    async function synchronizePackages() {
        packages = await store.listPackages();
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

    async function showPanel() {
        await refresh();
        const current = documentRef.getElementById(PANEL_ID);
        if (current) { closePanel(current); return; }
        const target = toolbar();
        if (!target) return;
        target.insertAdjacentHTML('afterend', panelMarkup(await storageEstimate()));
        bindPanel(documentRef.getElementById(PANEL_ID));
        setPanelExpanded(true);
    }

    async function downloadSong(song) {
        if (!song?.filename || busy) return;
        try {
            await ensureStorageReady();
        } catch (error) {
            notify(windowRef, 'Offline storage unavailable', error.message || String(error), '!', '#EF4444');
            return;
        }
        const existing = packageForSong(song);
        if (existing) {
            notify(windowRef, 'Offline bundle already stored', packageLabel(existing));
            return;
        }
        const label = packageLabel({ song: {
            artist: song.artist || 'Unknown artist',
            title: song.title || song.filename,
        }});
        const ok = await confirm({
            title: 'Download for offline practice?',
            html: 'Download <strong>' + esc(label) + '</strong> for later use?' +
                '<p class="mt-2 text-xs text-fb-textDim">This stores the full mix and the default chart for offline practice.</p>',
            confirmText: 'Download',
        });
        if (!ok) return;
        busy = true;
        try {
            const metadata = await download({
                filename: song.filename,
                baseHref: locationRef.href,
                locationRef,
            });
            await refresh();
            notify(windowRef, 'Offline bundle stored', packageLabel(metadata));
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
                applies: (song) => canUseOfflineActions(song) && !packageForSong(song),
                enabled: () => !busy,
                run: downloadSong,
            }),
            registry.register({
                id: OPEN_ACTION_ID,
                pluginId: 'core.offline-practice',
                label: 'Open offline',
                icon: '▶',
                placement: 'menu',
                order: 35,
                applies: (song) => canUseOfflineActions(song) && !!packageForSong(song),
                enabled: () => !busy,
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
                applies: (song) => canUseOfflineActions(song) && !!packageForSong(song),
                enabled: () => !busy,
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
