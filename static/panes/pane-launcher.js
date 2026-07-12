/*
 * fee[dB]ack — pane launcher (the "Panes" rail popover).
 *
 * A chip only works for a pane that already has a dialog to hide. Panes with no
 * dialog — a readout, a plugin's optional extra — need somewhere to be opened
 * from, so every registered pane gets one: a checkbox list in the rail.
 *
 * The rail popover is the right home for this precisely because it IS exclusive
 * and transient. It's a menu, not a workspace; the panes it opens are the
 * workspace, and they persist.
 *
 * Populated from the registry, so a plugin that calls panes.register() appears
 * here with no further work. (The system tray will mirror this list.)
 */
(function () {
    'use strict';

    const panes = window.feedBack && window.feedBack.panes;
    const bus = window.feedBack;
    if (!panes || !bus || typeof bus.on !== 'function') return;

    let listEl = null;

    function render() {
        if (!listEl || !listEl.isConnected) listEl = document.getElementById('v3-rail-panes-list');
        if (!listEl) return;
        const all = panes.list();

        // Toggling a pane from this list fires panes:opened/closed, which re-renders
        // the list — destroying the very button the user just pressed and dropping
        // focus to <body>. Remember which one had it and give it back, so keyboard
        // and screen-reader users can toggle several panes without losing their place.
        const focusedId = (listEl.contains(document.activeElement) && document.activeElement.dataset)
            ? document.activeElement.dataset.paneId : null;

        listEl.replaceChildren();

        if (!all.length) {
            const empty = document.createElement('div');
            empty.className = 'v3-pop-empty';
            empty.textContent = 'No panes available.';
            listEl.appendChild(empty);
            return;
        }

        all.forEach((p) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'v3-pop-btn';
            b.dataset.paneId = p.id;
            b.setAttribute('aria-pressed', p.open ? 'true' : 'false');
            b.textContent = (p.open ? '● ' : '○ ') + p.icon + ' ' + p.title;
            b.addEventListener('click', (e) => {
                e.stopPropagation();
                if (panes.isOpen(p.id)) panes.close(p.id); else panes.detach(p.id);
            });
            listEl.appendChild(b);
            if (p.id === focusedId) b.focus();
        });
    }

    // The registry changes when plugins load and when panes open/close. Render is
    // cheap and rare (never on a playback path), so just re-run it.
    bus.on('panes:registered', render);
    bus.on('panes:unregistered', render);
    bus.on('panes:opened', render);
    bus.on('panes:closed', render);

    if (document.readyState !== 'complete') document.addEventListener('DOMContentLoaded', render);
    else render();
})();
