(function () {
    'use strict';

    if (window.__fbPwaInstall) return;

    var installPrompt = null;
    var installed = isStandalone();
    var uiWired = false;

    function isStandalone() {
        try {
            if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
        } catch (_) { /* unsupported display-mode query */ }
        return window.navigator && window.navigator.standalone === true;
    }

    function isIos() {
        var nav = window.navigator || {};
        var ua = nav.userAgent || '';
        return /iPad|iPhone|iPod/i.test(ua)
            || (nav.platform === 'MacIntel' && Number(nav.maxTouchPoints) > 1);
    }

    function isIosSafari() {
        var ua = (window.navigator && window.navigator.userAgent) || '';
        var otherBrowser = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo|GSA|Brave/i;
        return isIos() && /Safari/i.test(ua) && !otherBrowser.test(ua);
    }

    function setVisible(element, visible) {
        if (element) element.classList.toggle('hidden', !visible);
    }

    function render() {
        var row = document.getElementById('pwa-install-row');
        var desc = document.getElementById('pwa-install-desc');
        var status = document.getElementById('pwa-install-status');
        var action = document.getElementById('pwa-install-action');
        if (!row || !desc || !status || !action) return;

        setVisible(row, false);
        setVisible(status, false);
        setVisible(action, false);
        status.textContent = '';

        if (installed) {
            desc.textContent = 'fee[dB]ack is installed on this device.';
            status.textContent = 'Installed';
            setVisible(row, true);
            setVisible(status, true);
            return;
        }

        if (installPrompt) {
            desc.textContent = 'Install fee[dB]ack on this device.';
            action.textContent = 'Install app';
            setVisible(row, true);
            setVisible(action, true);
            return;
        }

        if (!isIos()) return;

        setVisible(row, true);
        if (isIosSafari()) {
            desc.textContent = 'Use Safari to add fee[dB]ack to your Home Screen.';
            action.textContent = 'View steps';
            setVisible(action, true);
        } else {
            desc.textContent = 'Open fee[dB]ack in Safari to add it to your Home Screen.';
        }
    }

    function openIosGuidance() {
        var dialog = document.getElementById('pwa-install-ios-dialog');
        if (!dialog || dialog.open) return;
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
    }

    function closeIosGuidance() {
        var dialog = document.getElementById('pwa-install-ios-dialog');
        if (!dialog || !dialog.open) return;
        if (typeof dialog.close === 'function') dialog.close();
        else dialog.removeAttribute('open');
    }

    function handleInstallAction() {
        if (installPrompt) {
            var prompt = installPrompt;
            try { prompt.prompt(); } catch (_) { /* browser withdrew the prompt */ }
            installPrompt = null;
            render();
            return;
        }
        if (isIosSafari()) openIosGuidance();
    }

    function wireUi() {
        if (uiWired) return;
        var action = document.getElementById('pwa-install-action');
        var close = document.getElementById('pwa-install-ios-close');
        var done = document.getElementById('pwa-install-ios-done');
        if (!action || !close || !done) return;
        uiWired = true;
        action.addEventListener('click', handleInstallAction);
        close.addEventListener('click', closeIosGuidance);
        done.addEventListener('click', closeIosGuidance);
    }

    function init() {
        wireUi();
        render();
    }

    window.__fbPwaInstall = { refresh: render };

    window.addEventListener('beforeinstallprompt', function (event) {
        event.preventDefault();
        if (installed) return;
        installPrompt = event;
        render();
    });

    window.addEventListener('appinstalled', function () {
        installed = true;
        installPrompt = null;
        closeIosGuidance();
        render();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
