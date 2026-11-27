import {mutate, query, type UserApp} from './api'

// What the server says about an app's web page (omarchyd/apps.mjs, readinessOf).
export type Readiness = 'ready' | 'starting' | 'unreachable' | 'stopped' | 'gateway-down' | 'no-web'
export type Probe = {result: string; status?: number; location?: string | null; error?: string; readiness?: Readiness; container?: string; runningFor?: number; gateway?: boolean}
export type OpenResult = {opened: boolean; probe?: Probe | null}

export const askApp = (app: {id: string}) => query<Probe>('apps.probe', {appId: app.id})
// Opening an app inside My Own Data Center (the page listens for this and shows AppViewer).
export const VIEW_APP = 'omarchy:view-app'
export const canShowInside = (app: UserApp) => !(app.requiresHttps && location.protocol !== 'https:')

// Servers before 0.9.16 don't send `readiness`: any answer below 500 meant ready, everything else "starting".
const readinessOf = (p: Probe): Readiness => p.readiness ?? (p.result === 'no-web' ? 'no-web' : p.result === 'answered' && (p.status ?? 500) < 500 ? 'ready' : 'starting')

// A short label for an app's web page, shown next to "Running".
export function webStatus(p: Probe | null | undefined): {label: string; tone: 'ok' | 'wait' | 'bad'} | null {
	if (!p) return null
	const r = readinessOf(p)
	if (r === 'no-web') return null
	if (r === 'ready') return {label: 'Ready', tone: 'ok'}
	if (r === 'starting') return {label: 'Starting up…', tone: 'wait'}
	if (r === 'stopped') return {label: 'Stopped', tone: 'bad'}
	if (r === 'gateway-down') return {label: 'Its port on this server isn’t open', tone: 'bad'}
	return {label: 'Not answering', tone: 'bad'}
}

// Why an app that should open isn't opening, and what to do about it. null when there's nothing wrong.
export function explainProbe(name: string, p: Probe | null | undefined): string | null {
	if (!p) return null
	const r = readinessOf(p)
	if (r === 'ready' || r === 'no-web' || r === 'starting') return null
	if (r === 'stopped') return `${name} isn’t running. Start it, then open it.`
	if (r === 'gateway-down') return `${name} is answering, but its port didn’t open (another program may be using it). Restart ${name}; if that doesn’t help, restart this server.`
	const how =
		p.result === 'timeout'
			? 'accepts connections but hasn’t answered within 6 seconds'
			: p.result === 'refused'
				? 'isn’t listening on its web port'
				: `can’t be reached on its web port${p.error ? ` (${p.error})` : ''}`
	return `${name} is running, but its web page ${how}. It may have moved its page to a different port in its own settings, or it may have run into a problem: check its logs, or restart it.`
}

// Open an app, inside My Own Data Center when it can be shown there (see canShowInside). While the app is still
// starting (Home Assistant often is for its first minute), wait for it, so the tab doesn't land on a
// dead page. If it's running but not answering, don't wait: say so (see explainProbe) and let the
// person retry or open the address anyway. `onWaiting` is told while it waits.
export async function openApp(app: UserApp, url: string, {onWaiting, signal, force = false}: {onWaiting?: (seconds: number) => void; signal?: AbortSignal; force?: boolean} = {}): Promise<OpenResult> {
	mutate('apps.trackOpen', {appId: app.id}).catch(() => {})
	const started = Date.now()
	let last: Probe | null = null
	for (; !force; ) {
		if (signal?.aborted) return {opened: false}
		last = await askApp(app).catch(() => null)
		// Couldn't ask (network): just go.
		if (last === null) break
		const r = readinessOf(last)
		if (r === 'ready' || r === 'no-web') break
		if (r !== 'starting') return {opened: false, probe: last}
		const waited = Math.round((Date.now() - started) / 1000)
		if (waited > 180) return {opened: false, probe: {...last, readiness: 'unreachable'}}
		onWaiting?.(waited)
		await new Promise((r) => setTimeout(r, 2000))
	}
	if (signal?.aborted) return {opened: false}
	// Inside My Own Data Center, full screen with a back button, when the browser allows showing it
	// here. An app that needs https can't be shown inside an http page, so it gets the whole tab.
	if (canShowInside(app)) window.dispatchEvent(new CustomEvent<UserApp>(VIEW_APP, {detail: app}))
	else location.assign(url)
	return {opened: true, probe: last}
}
