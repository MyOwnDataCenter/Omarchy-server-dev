// Rules for account toasts. The screen renders these. It does not decide them.

export type ToastLevel = 'note' | 'problem'

export type ToastRecord = {
	id: string
	text: string
	at: number
	href: string | null
	expireAt: number | null
	level: ToastLevel
}

export function liveToasts(rows: readonly ToastRecord[], now: number): ToastRecord[] {
	return rows
		.filter((row) => row.expireAt == null || row.expireAt > now)
		.slice()
		.sort((a, b) => {
			const level = Number(b.level === 'problem') - Number(a.level === 'problem')
			return level || b.at - a.at
		})
}

export function spokenToast(rows: readonly ToastRecord[], now: number): ToastRecord | null {
	return liveToasts(rows, now)[0] ?? null
}

export function toastSurface(input: {floating: boolean; covered: boolean}): 'bubble' | 'box' {
	return input.floating && !input.covered ? 'bubble' : 'box'
}

export function staysLocal(input: {href: string | null; untilDismiss: boolean}): boolean {
	return !input.href && !input.untilDismiss
}
