const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

function roundTo(value: number, places: number): number {
	if (places <= 0) return Math.round(value)
	const factor = 10 ** places
	return Math.round(value * factor) / factor
}

// Round before the unit is kept. A value that lands on the next boundary (1000 KB, 1024 B)
// steps up, and the decimals come from that rounded value (100 KB, not 100.0 KB).
export function bytes(n: number | undefined, digits = 1, base: 1000 | 1024 = 1000): string {
	if (n === undefined || !Number.isFinite(n)) return '–'
	let value = n
	let i = 0
	for (;;) {
		const places = value >= 100 || i === 0 ? 0 : digits
		let shownPlaces = places
		let shown = roundTo(value, places)
		if (shown >= 100 && shownPlaces !== 0) {
			shownPlaces = 0
			shown = roundTo(value, 0)
		}
		const last = i === UNITS.length - 1
		if (last || shown < base) return `${shown.toFixed(shownPlaces)} ${UNITS[i]}`
		value /= base
		i++
	}
}
