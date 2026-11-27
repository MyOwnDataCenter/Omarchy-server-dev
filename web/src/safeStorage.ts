// Browser storage that never throws: a full, blocked or private-mode store just remembers nothing.
export const safeSession = {
	get(key: string): string | null {
		try {
			return sessionStorage.getItem(key)
		} catch {
			return null
		}
	},
	set(key: string, value: string): void {
		try {
			sessionStorage.setItem(key, value)
		} catch {
			/* not saved */
		}
	},
	remove(key: string): void {
		try {
			sessionStorage.removeItem(key)
		} catch {
			/* not saved */
		}
	},
}

export const safeLocal = {
	get(key: string): string | null {
		try {
			return localStorage.getItem(key)
		} catch {
			return null
		}
	},
	set(key: string, value: string): void {
		try {
			localStorage.setItem(key, value)
		} catch {
			/* not saved */
		}
	},
	remove(key: string): void {
		try {
			localStorage.removeItem(key)
		} catch {
			/* not saved */
		}
	},
}
