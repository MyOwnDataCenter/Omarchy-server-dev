export const SETTINGS_PAGE_STORAGE_KEY = 'omarchy-server:settings-page'
export const APPEARANCE_FOCUS_KEY = 'omarchy-server:appearance-focus'
// Set just before leaving the phone layout so the desktop, once it mounts, shows the shell
// that was just chosen. 'appearance' also reopens Appearance. 'retile' only retile the windows.
export const SHOW_SHELL_KEY = 'omarchy-server:show-shell'

export function settingsPayloadFor(page: string, nonce: number): {page: string; pageNonce: number} {
	return {page, pageNonce: nonce}
}

// Settings reads the storage key only as the first state value, so a new key remounts it on that page.
export function settingsRemountKey(payload?: {page?: string; pageNonce?: number} | null): string {
	return `${payload?.page ?? ''}:${payload?.pageNonce ?? ''}`
}

export function rememberSettingsPage(storage: {setItem: (key: string, value: string) => void}, page: string): void {
	storage.setItem(SETTINGS_PAGE_STORAGE_KEY, page)
}

export function rememberAppearanceFocus(storage: {setItem: (key: string, value: string) => void}, tab: string): void {
	storage.setItem(APPEARANCE_FOCUS_KEY, tab)
}

export function takeAppearanceFocus(storage: {getItem: (key: string) => string | null; removeItem: (key: string) => void}): string {
	const value = storage.getItem(APPEARANCE_FOCUS_KEY) ?? ''
	if (value) storage.removeItem(APPEARANCE_FOCUS_KEY)
	return value
}

// Open Settings at a page from anywhere (the first-run setup, say), in either layout.
export const OPEN_SETTINGS = 'omarchy-open-settings'
export function openSettingsPage(page: string): void {
	window.dispatchEvent(new CustomEvent<string>(OPEN_SETTINGS, {detail: page}))
}
