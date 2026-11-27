export type PhotoUploadSaved = {hsl: string; backgroundVersion: number | null}

// The upload awaits the photo, so the prefs object from when it started is stale.
// Build the next value from the prefs at the moment it finishes. Only the photo
// keys change, and a solid colour is cleared so the picture can show.
export function prefsAfterPhotoUpload<T extends {theme: string; solidColor?: string | null; customBrandHsl?: string | null; backgroundVersion?: number | null}>(
	latest: T,
	saved: PhotoUploadSaved,
	opts: {setThemeCustom: boolean},
): T {
	return {
		...latest,
		...(opts.setThemeCustom ? {theme: 'custom' as T['theme']} : {}),
		customBrandHsl: saved.hsl,
		backgroundVersion: saved.backgroundVersion,
		solidColor: null,
	}
}

export function prefsChoosingYourPhoto<T extends {theme: string; solidColor?: string | null}>(latest: T): T {
	return {...latest, theme: 'custom' as T['theme'], solidColor: null}
}

export function resolvePrefsUpdate<T>(current: T, next: T | ((current: T) => T)): T {
	if (typeof next === 'function') return (next as (current: T) => T)(current)
	return next
}

export function applyPrefsUpdate<T>(setPrefs: (next: T) => void, update: (current: T) => T): void {
	;(setPrefs as (next: T | ((current: T) => T)) => void)(update)
}
