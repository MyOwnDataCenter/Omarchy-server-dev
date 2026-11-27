import {bytes} from '../formatBytes.ts'

// freeGb and totalGb are bytes/1024**3. Show them in decimal units, same boundaries as bytes().
export function formatServerDiskGb(gb: number): string {
	if (!Number.isFinite(gb)) return '–'
	return bytes(gb * 1024 ** 3).replace(/\.0 (?=[A-Z])/, ' ')
}
