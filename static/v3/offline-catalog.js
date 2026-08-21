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

function normalizedFilename(value) {
    if (typeof value !== 'string') return '';
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
        const filename = normalizedFilename(metadata?.source?.filename);
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

function defaultOpenPackage(revision) {
    globalThis.location.assign(`/v3/?offline=1&revision=${encodeURIComponent(revision)}`);
}

function defaultConfirmDelete(label, count) {
    const subject = count === 1 ? label : `${label} and its ${count} stored arrangements`;
    return globalThis.confirm(`Delete ${subject} from this device?`);
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
    let groups = [];
    const busyGroups = new Set();

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
        const downloadedBytes = groups.reduce((total, group) => total + group.bytes, 0);
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

        for (const group of groups) {
            const metadata = group.metadata;
            const revision = metadata.revision;
            const isBusy = busyGroups.has(group.filename);
            const row = documentRef.createElement('li');
            row.className = 'package-row';

            const details = documentRef.createElement('div');
            details.className = 'package-details';
            const title = documentRef.createElement('strong');
            title.className = 'package-title';
            title.textContent = packageLabel(metadata);
            const meta = documentRef.createElement('span');
            meta.className = 'package-meta';
            const arrangementCount = group.packages.length;
            meta.textContent = `${arrangementCount} stored ${arrangementCount === 1 ? 'arrangement' : 'arrangements'} · ${formatBytes(group.bytes)}`;
            details.append(title, meta);

            const actions = documentRef.createElement('div');
            actions.className = 'package-actions';
            const openButton = documentRef.createElement('button');
            openButton.type = 'button';
            openButton.className = 'primary';
            openButton.textContent = isBusy ? 'Opening...' : 'Open';
            openButton.disabled = isBusy || !revision;
            if (revision) openButton.setAttribute('data-offline-open', revision);
            openButton.addEventListener('click', () => openGroup(group));
            const deleteButton = documentRef.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'secondary danger';
            deleteButton.textContent = isBusy ? 'Deleting...' : 'Delete';
            deleteButton.disabled = isBusy || !revision;
            if (revision) deleteButton.setAttribute('data-offline-delete', revision);
            deleteButton.addEventListener('click', () => removeGroup(group));
            actions.append(openButton, deleteButton);
            row.append(details, actions);
            list.append(row);
        }

        const count = groups.length;
        element('offline-package-count').textContent = `${count} offline ${count === 1 ? 'song' : 'songs'}`;
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
        groups = groupCompletePackages(await listPackages());
        renderPackages(await readStorageEstimate());
    }

    async function openGroup(group) {
        const revision = group?.metadata?.revision;
        const key = group?.filename;
        if (!revision || !key || busyGroups.has(key)) return;
        busyGroups.add(key);
        setError();
        renderPackages(await readStorageEstimate());
        try {
            await openPackage(revision);
        } catch (error) {
            setError(`Could not open ${packageLabel(group.metadata)}. ${error?.message || String(error)}`);
        } finally {
            busyGroups.delete(key);
            renderPackages(await readStorageEstimate());
        }
    }

    async function removeGroup(group) {
        const key = group?.filename;
        if (!key || busyGroups.has(key)) return;
        const label = packageLabel(group.metadata);
        if (!confirmDelete(label, group.packages.length)) return;

        busyGroups.add(key);
        setError();
        renderPackages(await readStorageEstimate());
        let failure = null;
        try {
            for (const metadata of group.packages) {
                try { await deletePackage(metadata.revision); } catch (error) { failure ||= error; }
            }
            try { await refresh(); } catch (error) { failure ||= error; }
            if (failure) {
                const prefix = group.packages.length === 1
                    ? `Could not delete ${label}. `
                    : `Could not delete all stored arrangements for ${label}. `;
                setError(prefix + (failure?.message || String(failure)));
            }
        } finally {
            busyGroups.delete(key);
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
