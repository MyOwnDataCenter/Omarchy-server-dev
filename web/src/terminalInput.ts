// xterm emits these when a program asked to hear about focus. Replaying a session
// turns that on while the screen is being drawn, with no focus or blur from the
// user, and the sequence is otherwise typed into the shell.
const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'

// Keep a focus report only when a real focus or blur caused it. Reports emitted
// while xterm replays the session are not typing.
export function forwardTerminalInput(data: string, fromFocusEvent: boolean): boolean {
	if (data === FOCUS_IN || data === FOCUS_OUT) return fromFocusEvent
	return true
}

// The tap that opened the terminal lands on the phone's stretched typing field.
// Focusing that field dumps the keyboard's composition into the shell and then
// swallows the following keys, so ignore that gesture.
export function ignoreOpeningFocus(coarse: boolean, elapsedMs: number, settleMs = 500): boolean {
	return coarse && elapsedMs < settleMs
}
