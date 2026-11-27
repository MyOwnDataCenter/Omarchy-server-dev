// Which end of a category row still has chips out of sight.
// A one-pixel slack keeps a rounding error from lighting an arrow that cannot move.
export function chipScrollEnds(scrollLeft: number, scrollWidth: number, clientWidth: number) {
	const max = Math.max(0, scrollWidth - clientWidth)
	return {
		back: scrollLeft > 1,
		more: max > 1 && scrollLeft < max - 1,
	}
}

// A chip crossing the visible edge is the one that should dissolve before the arrow.
// Positions are relative to the scroller's left edge. A one-pixel slack ignores rounding.
export function chipEdgeFade(clientWidth: number, chips: {left: number; right: number}[]) {
	const slack = 1
	return {
		fadeStart: chips.some((c) => c.left < -slack && c.right > slack),
		fadeEnd: chips.some((c) => c.left < clientWidth - slack && c.right > clientWidth + slack),
	}
}

// The next scroll position for one arrow press. Step almost a screen, and stop at either end.
export function chipScrollTarget(scrollLeft: number, scrollWidth: number, clientWidth: number, direction: -1 | 1) {
	const max = Math.max(0, scrollWidth - clientWidth)
	const step = Math.max(80, clientWidth - 36)
	return Math.min(max, Math.max(0, scrollLeft + direction * step))
}
