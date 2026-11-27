export type GridIcon = {key: string; col: number; row: number}

// Display positions only. Icons already inside the grid stay on their stored cell.
// Icons outside move to a free visible cell, and never share that cell.
export function iconsInView<T extends GridIcon>(icons: readonly T[], cols: number, rows: number): T[] {
	const colsN = Math.max(0, Math.floor(cols))
	const rowsN = Math.max(0, Math.floor(rows))
	const inside = (col: number, row: number) => col >= 0 && row >= 0 && col < colsN && row < rowsN
	const taken = new Set<string>()
	for (const icon of icons) {
		if (inside(icon.col, icon.row)) taken.add(`${icon.col},${icon.row}`)
	}
	const claim = () => {
		for (let c = 0; c < colsN; c++) {
			for (let r = 0; r < rowsN; r++) {
				const cell = `${c},${r}`
				if (taken.has(cell)) continue
				taken.add(cell)
				return {col: c, row: r}
			}
		}
		let n = 0
		for (;;) {
			const cell = `${colsN},${n}`
			if (!taken.has(cell)) {
				taken.add(cell)
				return {col: colsN, row: n}
			}
			n += 1
		}
	}
	return icons.map((icon) => {
		if (inside(icon.col, icon.row)) return icon
		const cell = claim()
		return {...icon, col: cell.col, row: cell.row}
	})
}
