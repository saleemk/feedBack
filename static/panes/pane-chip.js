/*
 * fee[dB]ack — the pop-out chip.
 *
 * One affordance, core-owned, identical everywhere: the small ⇱ button a plugin
 * drops into the panel it already has.
 *
 *     feedBack.panes.register({ id: 'camera_director', title: 'Camera', element: () => panelEl });
 *     feedBack.panes.attachChip(panelEl, 'camera_director');
 *
 * That is the entire adoption cost. Clicking the chip pops the panel out; a stub
 * takes its place so the user can find it again; closing the pane brings the panel
 * home and restores the chip. The plugin writes no show/hide logic — if it did,
 * every plugin would invent a slightly different one, which is exactly the
 * inconsistency this exists to prevent.
 *
 * The panel a chip is attached to is USUALLY the very element the pane moves into
 * the pop-out window — so most of the time there is nothing here left to hide, and
 * the job is simply to mark the hole it left. Hiding it would in fact be actively
 * harmful: `.fb-pane-detached` is `display:none !important`, and it would travel
 * with the node straight into the pane window and blank it.
 *
 * When the chip IS attached to something the pane didn't take (a wrapper, a
 * launcher row), that element stays put and is hidden with `.fb-pane-detached` —
 * a dedicated class, not `.hidden`/[hidden], because the panels we attach to
 * already toggle those themselves.
 */
(function () {
    'use strict';

    const panes = window.feedBack && window.feedBack.panes;
    if (!panes || typeof panes.register !== 'function') {
        console.error('[panes] pane-manager.js must load before pane-chip.js');
        return;
    }

    // paneId -> { el, chip, stub, spec }
    const attached = new Map();

    function _makeChip(spec) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'fb-pane-chip';
        b.title = 'Pop out';
        b.setAttribute('aria-label', 'Pop out ' + spec.title);
        b.textContent = '⇱';
        b.addEventListener('click', (e) => {
            // Rail popovers close on any document click that lands outside them
            // (player-chrome.js). Without this the popover would close under the
            // chip mid-click, which reads as the button not working.
            e.stopPropagation();
            e.preventDefault();
            panes.detach(spec.id);
        });
        return b;
    }

    function _makeStub(spec) {
        const s = document.createElement('button');
        s.type = 'button';
        s.className = 'fb-pane-stub';
        s.setAttribute('aria-label', 'Bring ' + spec.title + ' back');
        s.title = 'Bring it back';
        const glyph = document.createElement('span');
        glyph.className = 'fb-pane-stub-glyph';
        glyph.textContent = '⇲';
        const label = document.createElement('span');
        label.textContent = spec.title + ' is popped out';
        s.appendChild(glyph);
        s.appendChild(label);
        s.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            panes.close(spec.id);
        });
        return s;
    }

    // The pane is out. Leave a stub where its panel used to be.
    //
    // The subtlety: the panel a chip is attached to is USUALLY the very element the
    // pane moved into the pop-out window. It is no longer in this document at all —
    // so hiding it would be worse than pointless (the `display:none` travels with
    // the node and blanks the pane window, which is exactly the bug this fixes), and
    // the stub cannot be inserted "before it", because it is not here to be before.
    //
    // Hence `home`: the manager tells us where the element used to live, and the
    // stub goes there. If the chip is attached to something the pane did NOT take —
    // a wrapper, a launcher row — that element is still here, and we hide it as
    // before.
    function _onOpened(rec, detail) {
        // Did the pane take MY element?
        //
        // Ask the manager, which knows exactly what it handed to the host. Do not
        // try to infer it from the element:
        //
        //   - `isConnected` says "still here" for a panel sitting in a pane window.
        //     It IS connected — to that window.
        //   - `ownerDocument` says "still here" for a panel moved into the DOCK,
        //     which is in this very document. Hiding it there would blank a pane the
        //     user is looking at.
        //
        // Both were live bugs. The manager's answer is the only one that holds for
        // every host, and it works when reconciling after the fact (detail == null),
        // which is what a plugin rebuilding its panel mid-pop-out triggers.
        const takenEl = (detail && detail.el) || panes.elementOf(rec.spec.id);
        const moved = takenEl === rec.el;

        if (!moved && rec.el.isConnected) {
            rec.el.classList.add('fb-pane-detached');
            if (!rec.stub.isConnected && rec.el.parentNode) rec.el.parentNode.insertBefore(rec.stub, rec.el);
            return;
        }

        // Mark the hole the element left. `home` comes with the event, or from the
        // manager when we are reconciling after the fact.
        const home = (detail && detail.home) || panes.homeOf(rec.spec.id);
        if (!rec.stub.isConnected && home && home.parent && home.parent.isConnected) {
            const next = (home.next && home.next.parentNode === home.parent) ? home.next : null;
            home.parent.insertBefore(rec.stub, next);
        }
    }

    function _onClosed(rec) {
        // The element is back. Whatever we did to hide it, undo — including a class
        // it might have carried out of the document and back.
        rec.el.classList.remove('fb-pane-detached');
        rec.stub.remove();
    }

    /**
     * attachChip(el, paneId, opts)
     *
     * `el`   — the dialog to hide when the pane pops out. The chip is injected
     *          into `el.querySelector('[data-pane-header]')` when present, else
     *          prepended to `el` itself.
     * `opts` — { header: Element } to place the chip somewhere specific.
     *
     * Returns a detach function that removes the chip and stub and restores the
     * dialog — call it if your plugin tears its dialog down.
     */
    function attachChip(el, paneId, opts) {
        opts = opts || {};
        if (!(el instanceof Element)) throw new TypeError('panes.attachChip: el must be an Element');
        // Validate here, not at the insertBefore below. This is a public plugin API,
        // and a truthy non-Element `header` (a selector string, a jQuery-ish wrapper,
        // a ref object) is an easy mistake to make — one that would otherwise surface
        // as a confusing DOM exception from deep inside core.
        if (opts.header != null && !(opts.header instanceof Element)) {
            throw new TypeError('panes.attachChip(' + paneId + '): opts.header must be an Element');
        }
        const spec = panes.get(paneId);
        if (!spec) { console.warn('[panes] attachChip: register the pane first:', paneId); return () => {}; }
        if (attached.has(paneId)) { console.warn('[panes] attachChip: already attached:', paneId); return () => {}; }

        const chip = _makeChip(spec);
        const stub = _makeStub(spec);
        const host = opts.header || el.querySelector('[data-pane-header]') || el;
        if (host === el) host.insertBefore(chip, host.firstChild);
        else host.appendChild(chip);

        const rec = { el, chip, stub, spec };
        attached.set(paneId, rec);

        // Reconcile immediately: register() reopens a pane the user left open at
        // last unload, and that can land before (or after) attachChip runs.
        if (panes.isOpen(paneId)) _onOpened(rec, null);

        return () => {
            if (attached.get(paneId) !== rec) return;
            attached.delete(paneId);
            chip.remove();
            _onClosed(rec);
        };
    }

    // One pair of bus listeners for every chip, rather than one pair per chip.
    const bus = window.feedBack;
    if (bus && typeof bus.on === 'function') {
        bus.on('panes:opened', (e) => {
            const rec = attached.get(e.detail && e.detail.id);
            if (rec) _onOpened(rec, e.detail);
        });
        bus.on('panes:closed', (e) => {
            const rec = attached.get(e.detail && e.detail.id);
            if (rec) _onClosed(rec);
        });
    }

    window.feedBack.panes.attachChip = attachChip;
})();
