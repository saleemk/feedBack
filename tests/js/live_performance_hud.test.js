'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const hud = require('../../static/v3/live-performance-hud.js');
const INDEX_HTML = path.join(__dirname, '..', '..', 'static', 'v3', 'index.html');

test('accuracy percentage matches server formula', () => {
    assert.equal(hud.accuracyPct(84, 16), 84);
    assert.equal(hud.calculateLivePerformanceState({ hits: 84, misses: 16 }).accuracyPct, 84);
});

test('divide by zero returns null accuracy and idle state', () => {
    assert.equal(hud.accuracyPct(0, 0), null);
    const stats = hud.calculateLivePerformanceState({ hits: 0, misses: 0, streak: 0 });
    assert.equal(stats.accuracyPct, null);
    assert.equal(stats.state, 'idle');
    assert.equal(Number.isNaN(stats.accuracyPct), false);
});

test('fire state requires high accuracy and streak', () => {
    assert.equal(hud.calculateLivePerformanceState({ hits: 90, misses: 10, streak: 10 }).state, 'fire');
    assert.equal(hud.calculateLivePerformanceState({ hits: 95, misses: 5, streak: 9 }).state, 'strong');
});

test('smoke state for low accuracy', () => {
    assert.equal(hud.calculateLivePerformanceState({ hits: 40, misses: 60, streak: 0 }).state, 'smoke');
});

test('steady and recovery thresholds', () => {
    assert.equal(hud.calculateLivePerformanceState({ hits: 75, misses: 25, streak: 2 }).state, 'steady');
    assert.equal(hud.calculateLivePerformanceState({ hits: 55, misses: 45, streak: 1 }).state, 'recovery');
});

test('reset counters via bindRuntime song lifecycle', () => {
    const listeners = new Map();
    const sm = {
        on(event, fn) {
            const list = listeners.get(event) || [];
            list.push(fn);
            listeners.set(event, list);
        },
        emit(event, detail) {
            (listeners.get(event) || []).forEach((fn) => fn({ detail }));
        },
    };

    const runtime = hud.bindRuntime(sm);
    sm.emit('song:loading', { filename: 'song.archive' });
    assert.equal(runtime.isActive(), true);

    runtime.onHit();
    runtime.onHit();
    runtime.onMiss();
    assert.equal(runtime.getCounters().hits, 2);
    assert.equal(runtime.getCounters().misses, 1);
    assert.equal(runtime.getCounters().streak, 0);

    sm.emit('song:arrangement-changed', { filename: 'song.archive', arrangement: 1 });
    assert.deepEqual(runtime.getCounters(), { hits: 0, misses: 0, streak: 0, bestStreak: 0 });

    sm.emit('song:stop', { time: 12 });
    assert.equal(runtime.isActive(), false);
    assert.deepEqual(runtime.getCounters(), { hits: 0, misses: 0, streak: 0, bestStreak: 0 });
});

test('DOM text updates after hit and miss events', () => {
    class El {
        constructor(id) {
            this.id = id;
            this.textContent = '';
            this.className = 'hidden is-idle';
            this.attrs = {};
        }
        classList = {
            add: (c) => { if (!this.className.includes(c)) this.className += (this.className ? ' ' : '') + c; },
            remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        };
        setAttribute(k, v) { this.attrs[k] = String(v); }
    }

    const els = {
        root: new El('v3-live-performance-hud'),
        percent: new El('v3-live-performance-percent'),
        hits: new El('v3-live-performance-hits'),
        streak: new El('v3-live-performance-streak'),
        state: new El('v3-live-performance-state'),
    };

    const listeners = new Map();
    const sm = {
        on(event, fn) {
            const list = listeners.get(event) || [];
            list.push(fn);
            listeners.set(event, list);
        },
        emit(event, detail) {
            (listeners.get(event) || []).forEach((fn) => fn({ detail }));
        },
    };

    const runtime = hud.bindRuntime(sm, els);
    sm.emit('song:loading', { filename: 'song.archive' });

    assert.equal(els.percent.textContent, '\u2014');
    assert.equal(els.hits.textContent, 'Waiting for notes');

    runtime.onHit();
    runtime.onHit();
    runtime.onMiss();

    assert.equal(els.percent.textContent, '67%');
    assert.equal(els.hits.textContent, 'Hits 2 / 3');
    assert.equal(els.streak.textContent, 'Streak 0');
    assert.match(els.state.textContent, /Recovering/);
});

test('HUD stays hidden until the first note arrives, then reveals', () => {
    class El {
        constructor(id) {
            this.id = id;
            this.textContent = '';
            this.className = 'hidden is-idle';
        }
        classList = {
            add: (c) => { if (!this.className.includes(c)) this.className += (this.className ? ' ' : '') + c; },
            remove: (c) => { this.className = this.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
        };
        setAttribute() {}
    }
    const els = { root: new El('v3-live-performance-hud') };

    const listeners = new Map();
    const sm = {
        on(event, fn) { const l = listeners.get(event) || []; l.push(fn); listeners.set(event, l); },
        emit(event, detail) { (listeners.get(event) || []).forEach((fn) => fn({ detail })); },
    };

    const runtime = hud.bindRuntime(sm, els);
    sm.emit('song:loading', { filename: 'song.archive' });
    // Primed (tallying) but not yet visible — a user without note detection
    // never gets note:hit/note:miss, so the HUD must not show on load alone.
    assert.equal(runtime.isActive(), true);
    assert.ok(els.root.className.includes('hidden'));

    runtime.onHit();
    assert.ok(!els.root.className.includes('hidden'));

    // A new song re-hides until the next note.
    sm.emit('song:stop', { time: 1 });
    assert.ok(els.root.className.includes('hidden'));
    sm.emit('song:loading', { filename: 'song2.archive' });
    assert.ok(els.root.className.includes('hidden'));
});

test('idle state before judged notes', () => {
    const stats = hud.calculateLivePerformanceState({ hits: 0, misses: 0, streak: 0 });
    assert.equal(stats.state, 'idle');
    assert.equal(hud.formatPercentText(stats), '\u2014');
    assert.equal(hud.formatHitsText(stats), 'Waiting for notes');
});

test('v3 player markup includes live performance HUD', () => {
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    assert.match(html, /id="v3-live-performance-hud"/);
    assert.match(html, /id="v3-live-performance-percent"/);
    assert.match(html, /id="v3-live-performance-hits"/);
    assert.match(html, /id="v3-live-performance-streak"/);
    assert.match(html, /live-performance-hud\.js/);
});
