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
const ACTION_ID = 'offline-download';

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
    let busy = false;
    let actionUnregister = null;
    let observer = null;

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
        if (!storage || typeof storage.estimate !== 'function') return 'Unavailable';
        try {
            const estimate = await storage.estimate();
            return `${formatBytes(estimate.usage)} used / ${formatBytes(estimate.quota)} quota`;
        } catch { return 'Unavailable'; }
    }

    function panelMarkup(estimate) {
        const rows = packages.length
            ? packages.map((metadata) => {
                const bytes = (metadata.chart?.bytes || 0) + (metadata.audio?.bytes || 0);
                return '<li class="flex items-start justify-between gap-3 border-t border-fb-border/40 py-3">' +
                    '<div class="min-w-0"><div class="truncate text-sm text-fb-text">' +
                    esc(packageLabel(metadata)) + '</div><div class="text-xs text-fb-textDim">' +
                    esc(metadata.arrangement.name) + ' chart · ' + formatBytes(bytes) +
                    ' · stored ' + esc(formatDate(metadata.storedAt)) + '</div></div>' +
                    '<div class="flex shrink-0 gap-2"><button type="button" data-offline-play="' + esc(metadata.revision) +
                    '" class="rounded-md border border-fb-accent/60 px-2 py-1 text-xs text-fb-text">Practice</button>' +
                    '<button type="button" data-offline-delete="' + esc(metadata.revision) +
                    '" class="rounded-md border border-fb-border/60 px-2 py-1 text-xs text-fb-text">Delete</button></div></li>';
            }).join('')
            : '<li class="border-t border-fb-border/40 py-3 text-sm text-fb-textDim">No offline bundles stored.</li>';
        return '<section id="' + PANEL_ID + '" class="mb-4 border-y border-fb-border/50 bg-fb-sidebar/80 px-4 py-3" aria-labelledby="v3-offline-heading">' +
            '<div class="flex items-start justify-between gap-3"><div><h2 id="v3-offline-heading" class="text-sm font-semibold text-fb-text">Offline practice</h2>' +
            '<p class="mt-1 text-xs text-fb-textDim">Stored bundles play the downloaded full mix with the default chart.</p></div>' +
            '<button type="button" data-offline-close class="shrink-0 text-xs text-fb-textDim">Close</button></div>' +
            '<p class="mt-3 text-xs text-fb-textDim">' + esc(estimate) + '</p><ul class="mt-2">' + rows + '</ul></section>';
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

    async function refresh() {
        packages = await store.listPackages();
        updateCount();
        const panel = documentRef?.getElementById(PANEL_ID);
        if (panel) {
            panel.outerHTML = panelMarkup(await storageEstimate());
            bindPanel(documentRef.getElementById(PANEL_ID));
        }
        return packages;
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
        actionUnregister = registry.register({
            id: ACTION_ID,
            pluginId: 'core.offline-practice',
            label: 'Download for offline practice',
            icon: '↓',
            placement: 'menu',
            order: 35,
            applies: (song) => storageReady && song?.provider === 'local' && !!song?.filename,
            enabled: () => !busy,
            run: downloadSong,
        });
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

    async function start() {
        if (!documentRef || !storageReady) {
            try {
                await store.open();
                packages = await store.listPackages();
                storageReady = true;
            } catch (error) {
                storageReady = false;
                return { ready: false, error };
            }
        }
        registerAction();
        observeLibrary();
        return { ready: true, packages };
    }

    function destroy() {
        observer?.disconnect();
        observer = null;
        actionUnregister?.();
        actionUnregister = null;
        store.close();
    }

    return Object.freeze({ start, refresh, destroy, downloadSong });
}

if (globalThis.document) {
    void createOfflinePracticeController().start();
}
