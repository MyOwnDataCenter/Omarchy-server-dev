// Desktop windows scroll inside .win-scroll. Screens still call window.scrollTo, which does not move that box.
type ClickEvent = {target?: unknown}
type ClickDoc = {
	addEventListener(type: 'click', listener: (event: ClickEvent) => void, capture?: boolean): void
	removeEventListener(type: 'click', listener: (event: ClickEvent) => void, capture?: boolean): void
}
type ScrollHost = {
	scrollTo: (...args: never[]) => void
}

export function scrollCallGoesToTop(args: ReadonlyArray<unknown>): boolean {
	const first = args[0]
	if (typeof first === 'number') return first === 0 && (args.length < 2 || args[1] === 0)
	if (typeof first === 'object' && first !== null && 'top' in first) return first.top === 0
	return false
}

export function resetNearestWinScroll(from: unknown): boolean {
	if (typeof from !== 'object' || from === null || !('closest' in from) || typeof from.closest !== 'function') return false
	const found = from.closest('.win-scroll')
	if (typeof found !== 'object' || found === null || !('scrollTop' in found) || typeof found.scrollTop !== 'number') return false
	found.scrollTop = 0
	return true
}

export function bindWindowScrollReset(targetWindow: ScrollHost, targetDocument: ClickDoc): () => void {
	let from: unknown = null
	const onClick = (event: ClickEvent) => {
		from = event.target ?? null
		queueMicrotask(() => {
			from = null
		})
	}
	const orig = targetWindow.scrollTo.bind(targetWindow) as (...args: unknown[]) => void
	const wrapped = (...args: unknown[]) => {
		if (scrollCallGoesToTop(args)) resetNearestWinScroll(from)
		orig(...args)
	}
	targetWindow.scrollTo = wrapped as ScrollHost['scrollTo']
	targetDocument.addEventListener('click', onClick, true)
	return () => {
		targetDocument.removeEventListener('click', onClick, true)
		if (targetWindow.scrollTo === (wrapped as ScrollHost['scrollTo'])) targetWindow.scrollTo = orig as ScrollHost['scrollTo']
	}
}
