// How many trailing crumbs fit in the path bar.
// The current folder is always kept. Ancestors are added toward the root only while they fit.
// A crumb that does not fit is omitted whole. Names are not shortened.
export function fittingCrumbCount(widths: readonly number[], container: number): number {
	if (!widths.length) return 0
	let used = 0
	let count = 0
	for (let i = widths.length - 1; i >= 0; i--) {
		const w = widths[i]
		if (count > 0 && used + w > container) break
		used += w
		count += 1
	}
	return count
}
