// One history entry for a full-screen phone overlay (terminal or VM console).
// The system back gesture pops it. The on-screen Back button pops it only while that entry is still on top.
export const OVERLAY_HISTORY_KEY = 'omarchyOverlay'

// A popstate reveals the entry underneath. It closed us when that entry is not ours
// (a child entry popping back onto us must leave us open).
export function popstateClosesOverlay(revealed: Record<string, unknown> | null | undefined, id: string): boolean {
	return revealed?.[OVERLAY_HISTORY_KEY] !== id
}

// history.back() only when we have not already closed and our entry is still the current one.
export function overlayBackUsesHistory(closed: boolean, current: Record<string, unknown> | null | undefined, id: string): boolean {
	return !closed && current?.[OVERLAY_HISTORY_KEY] === id
}
