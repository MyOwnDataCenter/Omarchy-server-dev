export const SEQ = {esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', home: '\x1b[H', end: '\x1b[F', ctrlC: '\x03'}
export type TerminalMods = {ctrl: boolean; alt: boolean}

// Arrow, Home and End keys as a real keyboard sends them: full-screen programs (less, vim, htop)
// switch the terminal to "application" cursor keys (ESC O A rather than ESC [ A), and some only
// understand that form. Modified cursor keys always use CSI 1;<mod><letter>.
const CURSOR: Record<string, string> = {
	[SEQ.up]: 'A',
	[SEQ.down]: 'B',
	[SEQ.right]: 'C',
	[SEQ.left]: 'D',
	[SEQ.home]: 'H',
	[SEQ.end]: 'F',
	'\x1bOA': 'A',
	'\x1bOB': 'B',
	'\x1bOC': 'C',
	'\x1bOD': 'D',
	'\x1bOH': 'H',
	'\x1bOF': 'F',
}

// Apply latched Ctrl/Alt modifiers to terminal key sequences and clear only modifiers that were used.
export function applyTerminalModifiers(
	seq: string,
	mods: TerminalMods,
	opts: {appCursor?: boolean; applyAppCursor?: boolean} = {},
): {data: string; ctrl: boolean; alt: boolean} {
	const cursor = CURSOR[seq]
	if (cursor) {
		if (mods.ctrl || mods.alt) {
			const mod = 1 + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0)
			return {data: `\x1b[1;${mod}${cursor}`, ctrl: false, alt: false}
		}
		return {data: opts.applyAppCursor && opts.appCursor ? `\x1bO${cursor}` : seq, ctrl: false, alt: false}
	}
	if (seq.length === 1) {
		let out = seq
		let nextCtrl = mods.ctrl
		let nextAlt = mods.alt
		if (mods.ctrl) {
			const c = out.toUpperCase().charCodeAt(0)
			if (c >= 64 && c <= 95) {
				out = String.fromCharCode(c - 64)
				nextCtrl = false
			} else if (out === ' ') {
				out = '\x00'
				nextCtrl = false
			} else if (out === '/') {
				out = '\x1f'
				nextCtrl = false
			} else if (out === '?') {
				out = '\x7f'
				nextCtrl = false
			}
		}
		if (mods.alt) {
			out = `\x1b${out}`
			nextAlt = false
		}
		return {data: out, ctrl: nextCtrl, alt: nextAlt}
	}
	return {data: seq, ctrl: mods.ctrl, alt: mods.alt}
}
