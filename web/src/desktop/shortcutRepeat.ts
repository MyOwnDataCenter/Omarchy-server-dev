// Held keys repeat. One-shot chords (a terminal, close, grab, workspace, …) must
// run once. Arrow focus/swap, and keys forwarded into a focused console, keep repeating.
export function ignoreRepeatedDesktopShortcut(input: {
	repeat: boolean
	terminalChord: boolean
	action: {type: string} | null
	forwardsToConsole: boolean
}): boolean {
	if (!input.repeat) return false
	if (input.forwardsToConsole) return false
	if (input.terminalChord) return true
	if (!input.action) return false
	return input.action.type !== 'focus' && input.action.type !== 'swap'
}
