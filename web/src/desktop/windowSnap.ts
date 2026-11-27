export type MaximizeSnap = 'max' | 'left' | 'right' | null

// Only a maximized window restores. A half-snap still has a snap, but Maximize means fill the work area.
export function nextMaximizeSnap(snap: MaximizeSnap): 'max' | null {
	return snap === 'max' ? null : 'max'
}
