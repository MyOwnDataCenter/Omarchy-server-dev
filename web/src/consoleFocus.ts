// Focus the console on the connect that opened it. A later reconnect focuses only
// when the user is already in that window, so a background reconnect cannot steal
// the keyboard from another window.
export function consoleShouldTakeFocus(opts: {
	firstConnect: boolean
	activeElement: Node | null
	windowEl: {contains: (node: Node) => boolean} | null
}): boolean {
	if (opts.firstConnect) return true
	if (!opts.windowEl || !opts.activeElement) return false
	return opts.windowEl.contains(opts.activeElement)
}
