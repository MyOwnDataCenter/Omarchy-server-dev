# Hyprland desktop mode and Super-key grab

Date: 2026-11-16
Status: shipped in Omarchy Server 0.9.34 (PR #38, by calledtoconstruct). The design below is as written
for that PR; what changed in review is listed at the end.

## 1. Goal

Give the signed-in desktop layout an optional Hyprland-like shell (tiling, workspaces 1–9, Omarchy Super chords) and a way to get Super into the browser when the client machine is itself Omarchy.

The Ubuntu/GNOME desktop stays the default. Phone layout is unchanged.

## 2. Why

Omarchy Super chords are bound in the client compositor. The page never sees Super+Return, Super+1, Super+Space. The VM/desktop console already uses fullscreen `navigator.keyboard.lock()` on Chromium HTTPS. That path needs fullscreen, Chromium, and a secure context. HTTP and a normal window need a host-side passthrough instead.

## 3. Non-goals (v1)

- Native Qt/desktop client
- Auto-installing or writing `~/.config/hypr/bindings.lua` on the client
- Hyprland groups, scratchpad, quake console, swallow, per-monitor workspaces, screenshot/OCR/notification binds
- Replacing GNOME mode
- Changing phone layout
- Firefox Keyboard Lock (the API is Chromium-only)

## 4. Architecture

Three units. Window *contents* stay the existing React screens.

```
Omarchy host Hyprland                 Browser (omarchy-server SPA)
┌──────────────────────────┐          ┌─────────────────────────────────────┐
│ SCROLL_LOCK / SUPER+F12  │          │ grab.ts     keysLocked, capture mode│
│ non-consuming submap     │─────────►│ keymap.ts   chord → action          │
│ "passthrough"            │          │ layout.ts   dwindle per workspace   │
└──────────────────────────┘          │                                     │
                                      │  GNOME chrome  |  Hyprland chrome   │
                                      │  (same Win list + screens)          │
                                      └─────────────────────────────────────┘
```

| Unit | Lives | Job |
|---|---|---|
| Host passthrough | Client `~/.config/hypr/bindings.lua` | Empty Hyprland submap so Super reaches the focused window. Copy-paste snippet only. |
| Grab controller | `web/src/desktop/hyprland/grab.ts` | `keysLocked`, capture mode, Keyboard Lock, lock chip. |
| Hyprland shell | `layout.ts`, `keymap.ts`, bar/launcher in `web/src/desktop/hyprland/` | Tiling, workspaces, Omarchy chords. Mounted when `DeskConfig.shell === 'hyprland'`. |

`Desktop.tsx` stays the window host (open/close/focus, screens). It branches chrome: dock + Activities vs Hyprland bar + dwindle.

### Focus routing while Super is handled

Document-level capture listener:

1. Scroll Lock and Super+F12 always toggle grab, including over a focused console.
2. Active window `kind === 'console'` → remaining Super chords go to noVNC (`RFB.sendKey` when Keyboard Lock delivered the event to the top-level document).
3. Any other window or the desktop → shell keymap, `preventDefault`.

The title-bar close button always closes the SPA window. Super+Q on a focused console closes a window *inside* the VM.

## 5. Host passthrough snippet

Show this in Personalize → Keys and on the first-run card. Copy button. Never written to disk by the server.

```lua
o.bind("SCROLL_LOCK", "Pass keys to the focused window", hl.dsp.submap("passthrough"), { non_consuming = true })
o.bind("SUPER + F12", "Pass keys to the focused window", hl.dsp.submap("passthrough"), { non_consuming = true })
hl.define_submap("passthrough", function()
  o.bind("SCROLL_LOCK", "Return keys to Hyprland", hl.dsp.submap("reset"), { non_consuming = true })
  o.bind("SUPER + F12", "Return keys to Hyprland", hl.dsp.submap("reset"), { non_consuming = true })
end)
```

`non_consuming` is required so the page sees Scroll Lock / Super+F12 and can keep the lock chip in sync.

A Test control flashes when the page receives `KeyboardEvent.code === 'ScrollLock'`.

## 6. Grab controller

### State (session only; not persisted)

```ts
type CaptureMode = 'host' | 'keyboard-lock'
type LockMethod = 'none' | 'scroll' | 'keyboard-lock'

type GrabState = {
  keysLocked: boolean
  method: LockMethod
  mode: CaptureMode
}
```

Hyprland mode always honors Super when the page receives it. `keysLocked` is the chip and, in `keyboard-lock` mode, whether fullscreen Keyboard Lock is engaged. GNOME mode keeps Super-tap → Activities and does not bind Super+1.

### Capture mode (this browser only)

`localStorage` key `omarchy-server:key-capture`.

| Mode | Default | Lock chip click | Super steal |
|---|---|---|---|
| `host` | HTTP, or HTTPS without `navigator.keyboard.lock` | Toggle `keysLocked` only. No fullscreen. | Relies on the Hyprland snippet, or on an OS that already delivers Super to the page. |
| `keyboard-lock` | HTTPS + `navigator.keyboard?.lock` | `requestFullscreen({navigationUI:'hide'})` then `keyboard.lock()`. | Chromium delivers Super, Alt+Tab, Esc to the top-level document. |

`navigator.keyboard.lock()` runs only in a secure context (HTTPS or localhost). Capture mode cannot lift that. On HTTP, `keyboard-lock` is disabled and the row has **Open HTTPS** (`https://${location.host}`).

If the page is HTTP while stored mode is `keyboard-lock` (user followed an http:// link), coerce mode to `host` for this session and keep the Open HTTPS control.

Leaving fullscreen while `method === 'keyboard-lock'` calls `keyboard.unlock()`, sets `keysLocked` false, `method` `'none'`. Window blur does not unlock (the host submap may still be on). Reload starts unlocked.

### Enter / leave

| Control | Effect |
|---|---|
| Scroll Lock | Toggle. Host snippet also enters/leaves `passthrough`. |
| Super+F12 | Same toggle, for keyboards with no Scroll Lock. |
| Lock chip | Follows capture mode (table above). |
| Hold Esc / leave fullscreen | Unlocks Keyboard Lock (Chromium). |

### Limits (accepted in v1)

- Nested app iframes + `host` mode: Super stays in the iframe. Click the title bar, then Super+Q. `keyboard-lock` delivers keys to the top-level document, so Super works with the iframe focused.
- Firefox / HTTP: no Keyboard Lock. Host snippet or click-then-Super.
- Host submap and chip disagree if Scroll Lock is pressed while the browser is unfocused. The next Super that reaches the page still runs the keymap. The chip resyncs on the next Scroll Lock the page sees.

## 7. Hyprland shell

`DeskConfig.shell: 'gnome' | 'hyprland'`. Default `'gnome'`. Account-wide via existing `/api/desktop` (same as wallpaper/dock).

Personalize → new **Layout** segment: Ubuntu / Hyprland. Dock and desktop-icon tabs remain so switching back keeps those settings. In Hyprland mode those tabs note that the dock and icon grid are hidden.

Switching shell keeps the same `Win` list. Hyprland mode assigns `workspace: 1` and inserts non-minimized windows into a dwindle tree in z-order, storing each window’s last floating rect. GNOME mode restores those rects.

### Chrome

No dock, no desktop-icon grid, no Activities. Thin top bar (~34px), same `style-*` classes (yaru / glass / graphite / daylight):

- Left: workspace pills 1–9. Empty, occupied, active are distinct. Click switches. Minimized-only workspace shows a marker on the pill.
- Center: focused window title.
- Right: lock chip, existing CPU/mem stats, clock, system menu.

### Tiling (`layout.ts`)

Dwindle binary tree per workspace:

```ts
type Axis = 'h' | 'v' // h = left/right, v = top/bottom
type Node =
  | { kind: 'leaf'; id: string }
  | { kind: 'split'; axis: Axis; ratio: number; a: Node; b: Node }
```

- Empty workspace: wallpaper only. First window is a single leaf filling the area under the bar, minus 8px gaps.
- New window splits the focused leaf on the longer axis of that leaf’s rect, `ratio: 0.5`, existing leaf as `a`, new as `b`.
- Close: the sibling fills the space. Closing the last window on a workspace leaves the tree `null`.
- Super+J: flip `axis` on the focused leaf’s parent.
- Super+T: `float: true`, remove from tree, use `x,y,w,h` like GNOME (drag/resize). Super+T again inserts at the focused tile.
- Super+F: tile fills the usable area (`snap: 'max'`). Again restores the tree slot.
- Super+M: `min: true`, keep the leaf in the tree (sibling fills). Marker on the pill.
- Super+Shift+M: restore the most recently minimized window on this workspace (repeat for the next). It occupies its previous slot.
- Super+arrows: focus the nearest leaf whose center lies in that direction.
- Super+Shift+arrows: swap the focused leaf’s window id with that neighbor.

Gaps 8px. Focused tile: 2px accent border. Unfocused: 1px muted border.

Corrupt or missing tree on load: rebuild by inserting remaining non-float, non-min windows for that workspace in z-order. No toast.

### Workspaces

Each `Win` has `workspace: 1..9` (default 1). Super+1–9 switches the current workspace. Super+Shift+1–9 moves the focused window and follows it. Super+Tab / Super+Shift+Tab cycle 1→9 / 9→1, skipping nothing (empty workspaces are valid).

### Launcher and cheatsheet

- Super+Space: command palette overlay. Filter box; rows for apps, Files, Terminal, Machines, Settings, Personalize, installed apps, running machines. Enter opens. Esc closes. Reuses the same `openItem` / `launch` paths as the dock.
- Super+K: cheatsheet overlay listing the v1 keymap.
- Super+Escape: existing system menu.

First switch into Hyprland mode shows a one-time card (`localStorage` `omarchy-server:hyprland-onboarding`): paste the snippet, or use the lock chip (HTTPS). Dismiss stores the flag.

## 8. v1 keymap

Omarchy chord names, SPA actions. Implemented in `keymap.ts`. Ignored in GNOME mode except Super-tap (existing) and grab keys (no-ops unless Hyprland mode).

| Chord | Action |
|---|---|
| Scroll Lock | Grab toggle |
| Super+F12 | Grab toggle |
| Super+Return | Terminal |
| Super+Shift+F | Files |
| Super+Alt+Space | Apps |
| Super+Space | Launcher |
| Super+Escape | System menu |
| Super+K | Cheatsheet |
| Super+Q / Super+W | Close focused window |
| Super+F | Fullscreen tile |
| Super+T | Toggle float |
| Super+J | Toggle split axis |
| Super+Arrow | Focus in that direction |
| Super+Shift+Arrow | Swap in that direction |
| Super+1–9 | Switch workspace |
| Super+Shift+1–9 | Move focused window to workspace |
| Super+Tab | Next workspace |
| Super+Shift+Tab | Previous workspace |
| Super+M | Minimize focused |
| Super+Shift+M | Restore last minimized (reverse order of minimize) |

Super is `event.metaKey` or `event.key === 'Meta' | 'OS'`. Digits use `event.code` `Digit1`…`Digit9` so shift does not produce `!` / `@`.

## 9. Data

| State | Storage |
|---|---|
| `shell` | `DeskConfig` → `/api/desktop` (account). Default `'gnome'`. |
| `keyCapture` | `localStorage` `omarchy-server:key-capture`. |
| `Win.workspace`, `Win.float`, last floating `x,y,w,h` | Existing `omarchy-server:desktop` window list. |
| Dwindle trees | `localStorage` `omarchy-server:hypr-layout` `{ workspace: number, trees: Record<number, Node \| null> }`. |
| `keysLocked` | Memory. |
| Onboarding | `localStorage` `omarchy-server:hyprland-onboarding`. |

`clean()` in `config.ts` accepts `shell: 'hyprland'`, otherwise `'gnome'`. `/api/desktop` already stores an opaque config object (60 KB cap). No server schema change.

Phone: `useLayout().desktop === false` keeps `Shell`. Hyprland chrome mounts only inside `Desktop`.

## 10. Errors

| Case | Behaviour |
|---|---|
| `keyboard.lock()` or `requestFullscreen` rejects | Toast: open HTTPS, or use host passthrough and the snippet. Stay unlocked. |
| HTTP + stored `keyboard-lock` | Coerce to `host`. Show Open HTTPS. |
| Super in an iframe, `host` mode | No SPA action. Title-bar click then Super+Q still closes. |
| Copy snippet fails | Snippet text stays selectable. |
| Corrupt layout JSON | Rebuild trees from the window list. |

## 11. Files

Create:

- `web/src/desktop/hyprland/layout.ts` — dwindle: `insert`, `remove`, `focusDir`, `swapDir`, `flipSplit`, `rects`, `rebuild`
- `web/src/desktop/hyprland/keymap.ts` — `actionOf(event, { consoleFocused })`
- `web/src/desktop/hyprland/grab.ts` — capture mode, lock state, secure-context checks
- `web/src/desktop/hyprland/Bar.tsx` — workspace pills, title, lock chip
- `web/src/desktop/hyprland/Launcher.tsx` — Super+Space palette
- `web/src/desktop/hyprland/Cheatsheet.tsx` — Super+K
- `web/src/desktop/hyprland/Onboarding.tsx` — first-run card + snippet
- `test/hyprland-layout.test.mjs`
- `test/hyprland-keymap.test.mjs`
- `test/hyprland-grab.test.mjs`

Modify:

- `web/src/desktop/config.ts` — `shell` on `DeskConfig` / `clean` / `DEFAULT_CONFIG`
- `web/src/desktop/Desktop.tsx` — branch chrome; document key listener; persist `workspace` / `float`
- `web/src/desktop/Personalize.tsx` — Layout segment, Keys section
- `web/src/Console.tsx` — export a `sendKey`/`injectKey` the grab router can call when Keyboard Lock ate the event
- `web/src/styles.css` — Hyprland bar, tiles, pills, lock chip, launcher
- `web/src/changelog.ts` — 0.9.32 entry
- `package.json` — version `0.9.32`; `test` script adds `--experimental-strip-types`
- `README.md` — Super grab + Hyprland layout, snippet
- `test/server.test.mjs` — `/api/desktop` round-trip includes `shell: 'hyprland'`

`npm test` runs `node --test --experimental-strip-types --test-concurrency=1 test/*.test.mjs`. The three test files import the `.ts` modules directly (`../web/src/desktop/hyprland/layout.ts`, etc.). Node 22+ (including this machine’s v26) strips types. Do not copy the algorithm into the test tree.

## 12. Testing

Automated (`node --test`, existing `npm test`):

- Layout: empty insert; split longer axis; close sibling fills; focus/swap by direction; move to another workspace; `rebuild` after a broken tree; float remove/reinsert; minimize remove/reinsert.
- Keymap: every v1 chord; Digit1 vs Shift+Digit1; console-focused Super+Q is not `close`; Scroll Lock / Super+F12 are grab-toggle even when `consoleFocused`.
- Grab: toggle on/off; HTTP coerces `keyboard-lock` → `host`; leaving fullscreen unlocks that method; blur does not unlock; default mode HTTP → `host`, HTTPS with `lock` → `keyboard-lock`.
- `/api/desktop` POST `{config:{shell:'hyprland',wallpaper:'valley'}}` stores `shell`.

Manual on this Omarchy box, after merge and restart:

1. Personalize → Layout → Hyprland. First-run card appears. Ubuntu layout still works after switching back.
2. Paste snippet into `~/.config/hypr/bindings.lua`, `hyprctl reload`. Scroll Lock: chip on, Super+Return opens Terminal in the page, host Super+Return does not. Scroll Lock again: host Super+Return opens a host terminal.
3. Super+F12 same as Scroll Lock.
4. Super+1 / Super+2 workspaces; Super+arrows focus; Super+Q closes.
5. HTTPS lock chip: fullscreen, Super reaches the page without the snippet (Chromium). Hold Esc exits.
6. HTTP: keyboard-lock row disabled, Open HTTPS works, host mode lock chip toggles without fullscreen.
7. Console window focused while locked: Super+Return reaches the VM, not a new SPA terminal.

## 13. Changes in review (0.9.34)

- A new window (and a restored, moved or re-tiled one) splits the focused tile: the top window on that
  workspace, not the first one in the list.
- The Ubuntu layout's keyboard handling is unchanged: it listens after the page, as before. Only the
  Hyprland layout listens first (capture), so its Super shortcuts win over a focused window.
- The Hyprland bookkeeping in `focus` (switching workspace, re-tiling a restored window) only runs in
  the Hyprland layout.
- The console's Super button keeps Super held until it's clicked again (its key effect re-runs when
  the button is toggled; Super is now let go only when the console closes).
- The first-run card's Scroll Lock check listens in the capture phase, so it sees the key.
- The snippet is offered for `bindings.lua` (current Omarchy) and `bindings.conf` (Omarchy from
  before its Hyprland config moved to Lua): `bindn` there is the same non-consuming bind.
