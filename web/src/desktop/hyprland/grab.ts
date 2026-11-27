export type CaptureMode = 'host' | 'keyboard-lock'
export type LockMethod = 'none' | 'scroll' | 'keyboard-lock'
export type GrabState = {keysLocked: boolean; method: LockMethod; mode: CaptureMode}
export type ToggleSource = 'scroll' | 'f12' | 'chip'

export const CAPTURE_KEY = 'omarchy-server:key-capture'
export const ONBOARDING_KEY = 'omarchy-server:hyprland-onboarding'
export const SNIPPET = `o.bind("SCROLL_LOCK", "Pass keys to the focused window", hl.dsp.submap("passthrough"), { non_consuming = true })
o.bind("SUPER + F12", "Pass keys to the focused window", hl.dsp.submap("passthrough"), { non_consuming = true })
hl.define_submap("passthrough", function()
  o.bind("SCROLL_LOCK", "Return keys to Hyprland", hl.dsp.submap("reset"), { non_consuming = true })
  o.bind("SUPER + F12", "Return keys to Hyprland", hl.dsp.submap("reset"), { non_consuming = true })
end)`
// The same, for Omarchy installs from before its Hyprland config moved to Lua (bindings.conf).
// `bindn` is a non-consuming bind, like non_consuming = true above.
export const SNIPPET_CONF = `bindn = , Scroll_Lock, submap, passthrough
bindn = SUPER, F12, submap, passthrough
submap = passthrough
bindn = , Scroll_Lock, submap, reset
bindn = SUPER, F12, submap, reset
submap = reset`
export type SnippetFormat = 'lua' | 'conf'
export const SNIPPETS: Record<SnippetFormat, {text: string; file: string; label: string}> = {
	lua: {text: SNIPPET, file: '~/.config/hypr/bindings.lua', label: 'bindings.lua'},
	conf: {text: SNIPPET_CONF, file: '~/.config/hypr/bindings.conf', label: 'bindings.conf (older Omarchy)'},
}
// Which one this Omarchy uses: bindings.lua if that file is in ~/.config/hypr, bindings.conf otherwise.
export const SNIPPET_HELP = 'Omarchy now keeps its keys in bindings.lua. If ~/.config/hypr has bindings.conf instead, use that one.'

export function defaultMode(secure: boolean, hasLock: boolean): CaptureMode {
	return secure && hasLock ? 'keyboard-lock' : 'host'
}

export function coerceMode(mode: CaptureMode, secure: boolean): CaptureMode {
	return mode === 'keyboard-lock' && !secure ? 'host' : mode
}

export function canUseKeyboardLock(secure: boolean, hasLock: boolean): boolean {
	return secure && hasLock
}

type KeyboardLock = {lock: (codes?: string[]) => Promise<void>; unlock: () => void}
export function keyboardLockApi(): KeyboardLock | null {
	const k = (navigator as Navigator & {keyboard?: KeyboardLock}).keyboard
	return k && typeof k.lock === 'function' ? k : null
}

export function resolveMode(stored: string | null, secure: boolean, hasLock: boolean): CaptureMode {
	if (stored === 'host' || stored === 'keyboard-lock') return coerceMode(stored, secure)
	return defaultMode(secure, hasLock)
}

export function toggleLock(state: GrabState, source: ToggleSource): GrabState {
	const method: LockMethod = source === 'chip' && state.mode === 'keyboard-lock' ? 'keyboard-lock' : 'scroll'
	if (state.keysLocked) return {...state, keysLocked: false, method: 'none'}
	return {...state, keysLocked: true, method}
}

export function onFullscreenChange(state: GrabState, isFullscreen: boolean): GrabState {
	if (state.method === 'keyboard-lock' && !isFullscreen) return {...state, keysLocked: false, method: 'none'}
	return state
}

export function onBlur(state: GrabState): GrabState {
	return state
}

export function onCaptureModeChange(state: GrabState, next: CaptureMode): GrabState {
	if (state.method === 'keyboard-lock' && next !== 'keyboard-lock') return {keysLocked: false, method: 'none', mode: next}
	return {...state, mode: next}
}

// Scroll Lock and Super+F12 only flip flags. A lock taken with the browser still has to be released.
export function grabToggleReleasesKeyboardLock(prev: GrabState, next: GrabState): boolean {
	return prev.method === 'keyboard-lock' && !next.keysLocked
}

export function releaseKeyboardLock(): Promise<void> {
	try {
		keyboardLockApi()?.unlock()
	} catch {
		/* already unlocked */
	}
	try {
		const leaving = document.exitFullscreen()
		return Promise.resolve(leaving).catch(() => {
			/* already out */
		})
	} catch {
		/* already out */
		return Promise.resolve()
	}
}

export function chipIntent(state: GrabState): 'toggle' | 'request-keyboard-lock' | 'unlock-keyboard-lock' {
	if (state.mode !== 'keyboard-lock') return 'toggle'
	return state.keysLocked ? 'unlock-keyboard-lock' : 'request-keyboard-lock'
}
