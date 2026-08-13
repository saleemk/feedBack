import {
    deleteCompletePracticePackage,
    listCompletePracticePackages,
    openPracticePackageStore,
} from '../js/practice-package-store.js';

function packageLabel(metadata) {
    const artist = metadata?.song?.artist || 'Unknown artist';
    const title = metadata?.song?.title || metadata?.source?.filename || 'Untitled song';
    return `${artist} - ${title}`;
}

function formatBytes(value) {
    const bytes = Number(value);
    if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let amount = bytes / 1024;
    let unit = units[0];
    for (let index = 1; index < units.length && amount >= 1024; index += 1) {
        amount /= 1024;
        unit = units[index];
    }
    return `${amount >= 10 ? amount.toFixed(0) : amount.toFixed(1)} ${unit}`;
}

function packageBytes(metadata) {
    return Number(metadata?.chart?.bytes || 0) + Number(metadata?.audio?.bytes || 0);
}

function defaultOpenPackage(revision) {
    globalThis.location.assign(`/v3/?offline=1&revision=${encodeURIComponent(revision)}`);
}

function defaultConfirmDelete(label) {
    return globalThis.confirm(`Delete ${label} from this device?`);
}

async function defaultStorageEstimate() {
    if (typeof globalThis.navigator?.storage?.estimate !== 'function') return null;
    return globalThis.navigator.storage.estimate();
}

export function createOfflineCatalog({
    document: documentRef = globalThis.document,
    openPackageStore = openPracticePackageStore,
    listPackages = listCompletePracticePackages,
    deletePackage = deleteCompletePracticePackage,
    openPackage = defaultOpenPackage,
    confirmDelete = defaultConfirmDelete,
    estimateStorage = defaultStorageEstimate,
} = {}) {
    let startPromise = null;
    let packages = [];
    let busyRevision = null;

    function element(id) {
        const target = documentRef?.getElementById(id);
        if (!target) throw new Error(`Missing offline package element: ${id}`);
        return target;
    }

    function setError(message = '') {
        const target = element('offline-storage-error');
        target.textContent = message;
        target.hidden = !message;
    }

    function setStorageSummary(estimate = null) {
        const downloadedBytes = packages.reduce((total, metadata) => (
            total + packageBytes(metadata)
        ), 0);
        let summary = `${formatBytes(downloadedBytes)} downloaded`;
        if (Number.isFinite(estimate?.usage) && Number.isFinite(estimate?.quota)
                && estimate.quota > 0) {
            summary += ` · ${formatBytes(estimate.usage)} of ${formatBytes(estimate.quota)} device storage used`;
        }
        element('offline-storage-usage').textContent = summary;
    }

    function renderPackages(estimate = null) {
        const list = element('offline-package-list');
        const empty = element('offline-package-empty');
        list.replaceChildren();

        for (const metadata of packages) {
            const revision = metadata?.revision;
            const row = documentRef.createElement('li');
            row.className = 'package-row';

            const details = documentRef.createElement('div');
            details.className = 'package-details';
            const title = documentRef.createElement('strong');
            title.className = 'package-title';
            title.textContent = packageLabel(metadata);
            const meta = documentRef.createElement('span');
            meta.className = 'package-meta';
            meta.textContent = `${metadata?.arrangement?.name || 'Default chart'} · ${formatBytes(packageBytes(metadata))}`;
            details.append(title, meta);

            const actions = documentRef.createElement('div');
            actions.className = 'package-actions';
            const openButton = documentRef.createElement('button');
            openButton.type = 'button';
            openButton.className = 'primary';
            openButton.textContent = 'Open';
            openButton.disabled = Boolean(busyRevision) || !revision;
            if (revision) openButton.setAttribute('data-offline-open', revision);
            openButton.addEventListener('click', () => {
                if (revision && !busyRevision) openPackage(revision);
            });
            const deleteButton = documentRef.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'secondary danger';
            deleteButton.textContent = busyRevision === revision ? 'Deleting...' : 'Delete';
            deleteButton.disabled = Boolean(busyRevision) || !revision;
            if (revision) deleteButton.setAttribute('data-offline-delete', revision);
            deleteButton.addEventListener('click', () => removePackage(metadata));
            actions.append(openButton, deleteButton);
            row.append(details, actions);
            list.append(row);
        }

        const count = packages.length;
        element('offline-package-count').textContent = `${count} ${count === 1 ? 'download' : 'downloads'}`;
        empty.hidden = count !== 0;
        setStorageSummary(estimate);
    }

    async function readStorageEstimate() {
        try {
            return await estimateStorage();
        } catch (_) {
            return null;
        }
    }

    async function refresh() {
        packages = await listPackages();
        if (!Array.isArray(packages)) packages = [];
        renderPackages(await readStorageEstimate());
    }

    async function removePackage(metadata) {
        const revision = metadata?.revision;
        if (!revision || busyRevision) return;
        const label = packageLabel(metadata);
        if (!confirmDelete(label)) return;

        busyRevision = revision;
        setError();
        renderPackages(await readStorageEstimate());
        try {
            await deletePackage(revision);
            await refresh();
        } catch (error) {
            setError(`Could not delete ${label}. ${error?.message || String(error)}`);
        } finally {
            busyRevision = null;
            renderPackages(await readStorageEstimate());
        }
    }

    async function initialize() {
        try {
            await openPackageStore();
            await refresh();
            element('offline-package-manager').hidden = false;
            element('offline-storage-loading').hidden = true;
            setError();
            return true;
        } catch (error) {
            element('offline-package-manager').hidden = false;
            element('offline-storage-loading').hidden = true;
            element('offline-package-list').replaceChildren();
            element('offline-package-empty').hidden = true;
            element('offline-package-count').textContent = 'Downloads unavailable';
            element('offline-storage-usage').textContent = '';
            setError(
                `Downloaded songs could not be read on this device. ${error?.message || String(error)}`,
            );
            return false;
        }
    }

    function start() {
        if (!startPromise) startPromise = initialize();
        return startPromise;
    }

    return Object.freeze({ start, refresh });
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
