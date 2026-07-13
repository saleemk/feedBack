/*
 * fee[dB]ack — desktop upgrades for pane windows.
 *
 * In the desktop app a pane window is a real BrowserWindow: it remembers where you
 * put it, it stays off the taskbar, it minimizes to the system tray, and the tray
 * lists every pane you have.
 *
 * Note what this file does NOT do: it does not open the window, and it does not
 * close it. That stays in pane-window-host.js, and it stays `window.open()` —
 * because the pane's element is MOVED into that window's document, and a window
 * the main process created for us would give this realm no handle to adopt into.
 *
 * Electron turns our same-origin `window.open()` into a real BrowserWindow anyway,
 * and the main process recognises it by its frame name (`fbpane-<id>`) and takes
 * over the OS-level behaviour from there. So the only thing left to say across IPC
 * is "here are the panes that exist" — for the tray — and to listen for the tray
 * saying "open that one".
 *
 * In a browser, or on an older desktop build, this file does nothing and pop-out
 * works anyway. Everything here is an upgrade, not a dependency.
 */
(function () {
    'use strict';

    const panes = window.feedBack && window.feedBack.panes;
    const bus = window.feedBack;
    const desktop = window.feedBackDesktop && window.feedBackDesktop.panes;
    if (!panes || !bus || !desktop) return;

    // The tray asked to toggle a pane. Only this realm knows what that means — the
    // pane might belong in the dock, and its element lives here.
    desktop.onToggle((paneId) => {
        if (panes.isOpen(paneId)) panes.close(paneId);
        else panes.detach(paneId);
    });

    // Keep the tray's menu in step with the registry. Cheap and rare — panes are
    // registered at load and toggled by hand, never on a playback path.
    function sync() {
        desktop.sync(panes.list().map((p) => ({ id: p.id, title: p.title, icon: p.icon, open: p.open })));
    }
    bus.on('panes:registered', sync);
    bus.on('panes:unregistered', sync);
    bus.on('panes:opened', sync);
    bus.on('panes:closed', sync);
    sync();
})();
