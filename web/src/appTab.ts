// Opening an app in its own browser tab, and its address to copy (issue #86).
//
// On your network the page reaches this server on its own port, so the app's port on the same host
// works (appUrl). Behind a reverse proxy that only serves My Own Data Center (https on 443) it doesn't:
// then the app opens at its own app address (/api/app-open, when app addresses are set up), or you're
// told it needs one, instead of a tab that can't load.
import {useCallback} from 'react'

import type {UserApp} from './api'
import {appUrl} from './appUrl'
import {useBootstrap} from './data'
import {useToast} from './ui'

export const NEEDS_APP_ADDRESSES = 'Apps can’t open in their own tab from here: this page comes through a proxy that doesn’t reach their ports. Set app addresses (see the README), or open the app in a window.'

type OpenResult = {url: string; address?: string}

async function relayed(appId: string): Promise<OpenResult> {
	const res = await fetch(`/api/app-open?app=${encodeURIComponent(appId)}`, {credentials: 'same-origin'})
	const body = await res.json().catch(() => null)
	if (!res.ok || !body?.url) throw new Error(body?.error?.message ?? 'Couldn’t open the app')
	return body
}

export function useAppTab() {
	const boot = useBootstrap()
	const toast = useToast()
	const access = boot.server?.appAccess ?? 'direct'
	const host = boot.server?.host ?? location.hostname

	// Opens the tab right away (in the tap, so the browser allows it), then points it at the app.
	const openTab = useCallback(
		(app: UserApp) => {
			if (access === 'none') {
				toast(NEEDS_APP_ADDRESSES, true)
				return
			}
			if (access === 'direct') {
				const url = appUrl(app, host)
				if (url) window.open(url, '_blank', 'noopener')
				return
			}
			const tab = window.open('about:blank', '_blank')
			if (tab) tab.opener = null
			relayed(app.id)
				.then(({url}) => {
					if (tab) tab.location.href = url
					else window.open(url, '_blank', 'noopener')
				})
				.catch((e: Error) => {
					tab?.close()
					toast(e.message, true)
				})
		},
		[access, host, toast],
	)

	// The address to copy or bookmark: the app's own address when there's one, never a one-time link.
	const address = useCallback(
		async (app: UserApp): Promise<string | null> => {
			if (access === 'direct') return appUrl(app, host)
			if (access === 'none') return null
			const r = await relayed(app.id)
			return r.address ?? null
		},
		[access, host],
	)

	return {openTab, address, access}
}
