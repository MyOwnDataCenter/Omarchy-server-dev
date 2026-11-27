export const IN_APP_HISTORY_KEY = 'omarchy-server:in-app-history'

/** Back on Settings, Store, and Clips: home on a direct open, history after go() has pushed. */
export function inAppBackTarget(flag: string | null): 'home' | 'back' {
	return flag === '1' ? 'back' : 'home'
}

export function readInAppHistoryFlag(getItem: (key: string) => string | null): string | null {
	try {
		return getItem(IN_APP_HISTORY_KEY)
	} catch {
		return null
	}
}

export function markInAppHistory(setItem: (key: string, value: string) => void): void {
	try {
		setItem(IN_APP_HISTORY_KEY, '1')
	} catch {
		/* sessionStorage can throw */
	}
}
