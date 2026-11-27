export type InjectKey = {type: string; code: string; key: string}
type Handler = (e: InjectKey) => void

const handlers = new Map<string, Handler>()

export function setConsoleKeyHandler(id: string, h: Handler | null) {
	if (h) handlers.set(id, h)
	else handlers.delete(id)
}

export function injectConsoleKey(id: string, e: InjectKey) {
	handlers.get(id)?.(e)
}

export function releaseConsoleSuper(id: string) {
	handlers.get(id)?.({type: 'keyup', code: 'MetaLeft', key: 'Meta'})
}

const KEY = {
	Escape: 0xff1b,
	Tab: 0xff09,
	Enter: 0xff0d,
	Backspace: 0xff08,
	Insert: 0xff63,
	Delete: 0xffff,
	Home: 0xff50,
	End: 0xff57,
	PageUp: 0xff55,
	PageDown: 0xff56,
	Left: 0xff51,
	Up: 0xff52,
	Right: 0xff53,
	Down: 0xff54,
	Shift: 0xffe1,
	ShiftRight: 0xffe2,
	Ctrl: 0xffe3,
	CtrlRight: 0xffe4,
	Alt: 0xffe9,
	AltRight: 0xffea,
	Space: 0x20,
}

const CODE_KEYSYM: Record<string, number> = {
	Enter: KEY.Enter,
	NumpadEnter: KEY.Enter,
	Space: KEY.Space,
	Tab: KEY.Tab,
	Escape: KEY.Escape,
	Backspace: KEY.Backspace,
	Delete: KEY.Delete,
	Insert: KEY.Insert,
	Home: KEY.Home,
	End: KEY.End,
	PageUp: KEY.PageUp,
	PageDown: KEY.PageDown,
	ArrowUp: KEY.Up,
	ArrowDown: KEY.Down,
	ArrowLeft: KEY.Left,
	ArrowRight: KEY.Right,
	ShiftLeft: KEY.Shift,
	ShiftRight: KEY.ShiftRight,
	ControlLeft: KEY.Ctrl,
	ControlRight: KEY.CtrlRight,
	AltLeft: KEY.Alt,
	AltRight: KEY.AltRight,
}
for (let i = 1; i <= 12; i++) CODE_KEYSYM[`F${i}`] = 0xffbd + i

export function isSuperCode(code: string, key: string) {
	return ['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'].includes(code) || key === 'Meta' || key === 'OS'
}

export function keysymFromEvent(e: {code: string; key: string}): {keysym: number; code: string} | 'super' | null {
	if (isSuperCode(e.code, e.key)) return 'super'
	if (CODE_KEYSYM[e.code] != null) return {keysym: CODE_KEYSYM[e.code], code: e.code}
	if (e.key.length === 1) {
		const cp = e.key.codePointAt(0)!
		return {keysym: cp < 0x100 ? cp : 0x01000000 | cp, code: e.code}
	}
	return null
}

export type WinLike = {id: string; kind: string; min: boolean; z: number; workspace?: number; minAt?: number}

export function topVisibleWindow<T extends WinLike>(wins: T[], workspace: number, hypr: boolean): T | undefined {
	return wins.filter((w) => !w.min && (!hypr || (w.workspace ?? 1) === workspace)).sort((a, b) => b.z - a.z)[0]
}

export function lastMinimizedOn<T extends WinLike>(wins: T[], workspace: number): T | undefined {
	return wins.filter((w) => w.min && (w.workspace ?? 1) === workspace).sort((a, b) => (b.minAt ?? 0) - (a.minAt ?? 0) || b.z - a.z)[0]
}
