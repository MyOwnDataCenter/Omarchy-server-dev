// A failure is kept only for the url and sign-in state that produced it.
// The sign-in page gets 401 for the same wallpaper the desktop can load after sign-in.
export function wallpaperBlocked(failedUrl: string | null, failedSession: boolean, url: string | null, session: boolean): boolean {
	return !!url && failedUrl === url && failedSession === session
}
