# Detachable panes (`window.feedBack.panes`)

Pop a panel out of the app into its own OS window, and leave it there: while you
play, across song switches, on a second monitor, minimized to the system tray.

Panes exist because the player's rail popovers are **exclusive** — opening one
closes the last. You cannot watch the mixer while riding the camera, and both
vanish the moment you want to look at the highway.

---

## The whole idea, in one sentence

**We move the real element.**

Not a copy of your panel. Not a re-implementation of it in the pop-out window.
The actual DOM node. Same-origin windows can adopt each other's nodes, and an
adopted node keeps its event listeners and its closures — so your panel goes on
running *your* code, against *your* state, in *your* realm. The app's stylesheets
are copied into the pane window, so it looks identical too.

What you popped out is what you get. That is the promise, and it is the reason
there is no `ctx`, no state mirroring, no cross-window RPC and no second copy of
your UI to keep in step with the first. Those are all solutions to a problem we
simply do not have.

---

## Adding a pane to your plugin

Two lines.

```js
// Guard: the panes API is optional. On a host without it, skip both calls and
// your panel behaves exactly as it does today.
const panes = window.feedBack && window.feedBack.panes;
if (panes && typeof panes.register === 'function') {
    panes.register({
        id: 'camera_director',
        title: 'Camera Director',
        icon: '🎥',
        element: () => panelEl,      // your existing panel, as it is
    });
    panes.attachChip(panelEl, 'camera_director');
}
```

`attachChip()` injects **the** standard pop-out chip (`⇱`) — same glyph, same
place, same behaviour in every plugin. Clicking it moves your panel to whichever
**host** the router picks — usually a pop-out window, but the dock when a window
can't be had (a blocked pop-up, or `defaultHost: 'dock'`) — and leaves a
"⇲ … is popped out" stub in its place. Clicking the stub brings the panel back, to
exactly the spot it left. Core owns the chip, the hiding and the stub, so you write
no show/hide logic.

That's it. Your sliders, your presets, your tabs, your CSS, your event handlers,
your state — all of it comes along, because none of it moved anywhere except into
a different window's document.

### `element` is a function for a reason

It is resolved at open time, not at registration. Plugins commonly build their
panel lazily on first use, or rebuild it wholesale when something changes (Camera
Director rebuilds its panel on every mode change). Asking for it when we need it
means we always move the live one.

**If you rebuild your panel, re-attach the chip.** Rebuilding takes the chip with
it. `attachChip()` returns a `detach()`; call it before re-attaching, and again in
your teardown — otherwise you leave a stub pointing at DOM that no longer exists.

```js
if (chipDetach) chipDetach();
chipDetach = panes.attachChip(panel, PANE_ID, { header: toolsEl });
```

Re-attaching is safe while the pane is popped out: the chip reconciles against the
pane's real state, so a panel rebuilt mid-pop-out stays correctly stubbed.

### The two things core changes about your element

**1. Placement.** `.fb-paned` is added while the pane is out:

```css
position: static; inset: auto; margin: 0; width: 100%;
max-width: none; max-height: none; z-index: auto; box-shadow: none;
```

Your panel was almost certainly a fixed overlay pinned to a corner of the app
(`position:fixed; top:72px; right:18px; width:288px`). Alone in its own window,
every one of those is wrong — it would float 72px down from the top of a 380px
window, still 288px wide, still casting a shadow over nothing.

Note there is deliberately **no `display` override**: a panel that is
`display:flex` or `grid` stays that way. Colours, borders, radius, padding, fonts
and your panel's own internal layout are untouched.

**2. Visibility.** A panel is usually hidden until its launcher is clicked, and a
pane can be opened from the tray or the rail without that ever happening — so core
un-hides it, in the two ways a panel is actually hidden:

```js
el.hidden = false;
if (el.style.display === 'none') el.style.display = '';
```

**Both are restored exactly as they were when the pane docks**, along with the
`.fb-paned` class. A panel that was closed when you opened its pane from the tray
goes back to being closed; one that was open stays open.

---

## Spec

```js
feedBack.panes.register({
    id,                    // required, unique
    element,               // required — an Element, or a function returning one
    title,                 // shown in the pane window's title bar, the dock card, the tray
    icon,                  // one glyph, for the dock/tray/launcher lists
    width, height,         // the pane window's initial size (it remembers yours after that)
    defaultHost,           // 'window' (default) or 'dock'
    onHost,                // optional (hostId | null, el) => void — re-measure/re-anchor
});
```

```js
feedBack.panes.attachChip(el, paneId, { header })   // → detach()
feedBack.panes.open(id, { host }) / close(id) / detach(id) / dock(id) / focus(id)
feedBack.panes.isOpen(id) / hostOf(id) / get(id) / list()
```

`attachChip` puts the chip in the `header` element you pass, else in
`el.querySelector('[data-pane-header]')` if it finds one, else at the top of `el`.
An explicit `header` always wins.

---

## Hosts

`detach(id)` puts a pane in the best host available:

| host | | |
|---|---|---|
| `window` | 10 | A real OS window. In the desktop app: remembered bounds, always-on-top, system tray. |
| `dock` | 0 | A card in the in-window stack. **The floor** — always available, so opening a pane can never fail. |

You don't pick; you declare `defaultHost` and the router does the rest.

In the **desktop app** a pane you left popped out comes back popped out on next
launch. In a **browser** it comes back **docked** — a browser blocks
`window.open()` without a user gesture, so restoring it would only ever produce a
"pop-up blocked" toast. The chip pops it out again on your next click.

---

## Best practices

Every item below is something that has already gone wrong, in this codebase, on
this feature. They are cheap to get right up front and confusing to diagnose later
— a broken pane usually *looks* perfect.

### 1. Your code still runs in the main window

The element is *displayed* in the pane window, but its closures, its timers and its
`document` references all still belong to the main realm. **That is precisely why
everything keeps working** — and it has one sharp consequence:

```js
// WRONG — lands in the MAIN window, not the pane the user is looking at.
document.body.appendChild(myTooltip);

// RIGHT — anchored to the panel, so it travels with it.
panelEl.appendChild(myTooltip);
```

Same for measuring. `window.innerWidth` is the *main* window's. Use
`el.ownerDocument.defaultView` when you need the window your panel is actually in.

### 2. Don't hide your panel yourself

Core hides it and leaves a "bring it back" stub. If your plugin *also* hides it,
you are hiding the node that just moved — and the pane window renders nothing.
(This is not hypothetical: core's own chip did exactly this, and the first
pop-out shipped blank because of it.)

### 3. Prefer `hidden` or a class for show/hide

Core makes your panel visible while it's hosted — it clears `hidden`, and clears an
inline `display: none` if that's how you hide — and **restores both on dock**. So
either style works.

`hidden` is still the better choice: it composes with everything, and it leaves
your panel's `display` mode (`flex`, `grid`, whatever it is) entirely alone. Core
deliberately does not override `display` for exactly that reason.

```js
panel.hidden = true;                  // best
panel.style.display = 'none';         // works — core saves and restores it
```

### 4. `element` is a function — return the *live* node

It is resolved when the pane opens, not when you register. Plugins build panels
lazily, and rebuild them wholesale (Camera Director rebuilds on every mode
change). If you rebuild yours, **re-attach the chip**:

```js
if (chipDetach) chipDetach();            // attachChip returns a detach()
chipDetach = feedBack.panes.attachChip(panel, PANE_ID, { header: toolsEl });
```

Call `chipDetach()` in your teardown too, or you leave a stub pointing at DOM that
no longer exists.

### 5. `isConnected` does not mean "docked"

A panel sitting in a pane window is **connected** — just not to *this* document.
Code that asks "am I still mounted?" with `isConnected` will get `true` and act on
a panel that is somewhere else entirely.

```js
const docked = el.ownerDocument === document;   // this is the question you meant
```

Or take the optional `onHost(hostId, el)` callback, which fires on both moves.

### 6. Expect rAF to be throttled while your pane has focus

Chromium throttles a **backgrounded** window's `requestAnimationFrame` — and the
main window is exactly what's backgrounded while the user is looking at your pane.
Your rAF lives in the main window.

Event-driven panels (sliders, buttons, presets) don't care. A panel that
*animates continuously* may run slowly precisely when it's the only thing on
screen. Drive such animation from data you already have, or accept the stutter.

### 7. Don't synchronise anything

No `BroadcastChannel`, no `postMessage`, no second copy of your state, no mirrored
UI. There is **one** realm and **one** panel. If you find yourself writing sync
code, you have misunderstood the model — the whole point is that there is nothing
to sync.

### 8. Nothing here is required

On a host without the panes API, `feedBack.panes` is `undefined`. Skip both calls
and your panel behaves exactly as it does today. Guard, don't depend:

```js
const panes = window.feedBack && window.feedBack.panes;
if (!panes || typeof panes.register !== 'function') return;
```

---

## Things core guarantees

- **The element goes home exactly where it came from** — same parent, same position
  among its siblings. Don't move it yourself while it's popped out.
- **It comes home alive.** Core evacuates the element *before* the pane window's
  document is destroyed. (Get this wrong — dock after the window dies — and the
  node returns looking perfect with every listener in its subtree silently gone.
  That bug is why this section exists.)
- **A pane window the user closes, or that crashes, is reaped** and the element
  docked back. Your panel is never stranded in a dead document.
- **The app's stylesheets are copied into the pane window**, so your panel looks
  identical — including your plugin's own `styles` sheet.
