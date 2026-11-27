export type FormatKind = 'blank' | 'ext4' | 'exfat'

export function formatConfirmToken(d: {model?: string | null; serial?: string | null; name: string}) {
	const model = String(d.model ?? '').trim()
	if (model) return model
	const serial = String(d.serial ?? '').trim()
	if (serial.length >= 4) return serial.slice(-4)
	return d.name
}

export function formatPhraseMatches(d: {model?: string | null; serial?: string | null; name: string}, typed: string) {
	return typed.trim().toLowerCase() === formatConfirmToken(d).toLowerCase()
}

export function canFormat(d: {role: string; mounted: boolean}) {
	return (d.role === 'data' || d.role === 'blank') && !d.mounted
}

export function canUnmount(d: {role: string; mounted: boolean}) {
	return (d.role === 'data' || d.role === 'blank') && d.mounted
}

export function canMount(d: {role: string; mounted: boolean}) {
	return d.role === 'data' && !d.mounted
}
