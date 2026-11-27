// Smooth cubic for the System live-card sparkline (last-N poll points).
export const SPARK_WIDTH = 300
export const SPARK_HEIGHT = 54

export function sparkPath(
	series: number[],
	{width = SPARK_WIDTH, height = SPARK_HEIGHT, max = 100}: {width?: number; height?: number; max?: number} = {},
): string {
	if (series.length < 2) return ''
	const step = width / Math.max(series.length - 1, 1)
	const y = (v: number) => height - 3 - (Math.min(v, max) / max) * (height - 8)
	const pts = series.map((v, i) => [i * step, y(v)] as const)
	let d = `M${pts[0][0]},${pts[0][1]}`
	for (let i = 1; i < pts.length; i++) {
		const [x0, y0] = pts[i - 1]
		const [x1, y1] = pts[i]
		const cx = (x0 + x1) / 2
		d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`
	}
	return d
}
