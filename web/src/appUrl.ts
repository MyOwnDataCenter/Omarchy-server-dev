// The address an app opens at. Kept free of imports so it can be tested on its own.
export type UrlApp = {port?: number | null; viewPort?: number | null; internalPort?: number | null; path?: string | null; requiresHttps?: boolean}

// Most apps sit behind My Own Data Center's gateway on their port, which answers http:// and https://
// alike (My Own Data Center's own certificate). https is used when this page is https (a page on https
// can't show an http one) or when the app needs a secure page.
//
// An app that holds its own port (host network, e.g. Home Assistant on 8123) speaks only its own
// plain http there, so https://…:8123 can never work. When https is needed, such an app is opened
// through its view gateway instead (viewPort), which answers https and sits behind the sign-in.
export function appUrl(app: UrlApp, host: string, pageIsHttps = typeof location !== 'undefined' && location.protocol === 'https:') {
	if (!app.port) return null
	const secure = !!app.requiresHttps || pageIsHttps
	const ownPortOnly = !app.internalPort && !!app.viewPort
	const port = secure && ownPortOnly ? app.viewPort : app.port
	return new URL(app.path ?? '', `${secure ? 'https:' : 'http:'}//${host}:${port}`).href
}
