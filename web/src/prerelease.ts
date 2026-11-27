// Pre-release trials share one switch on this browser. It does not follow the account.
import {useEffect, useState} from 'react'

export const PRERELEASE_KEY = 'omarchy-server:prerelease'
const EVENT = 'omarchy-prerelease'

export function readPreRelease(): boolean {
	try {
		return localStorage.getItem(PRERELEASE_KEY) === '1'
	} catch {
		return false
	}
}

export function setPreRelease(on: boolean) {
	try {
		if (on) localStorage.setItem(PRERELEASE_KEY, '1')
		else localStorage.removeItem(PRERELEASE_KEY)
	} catch {
		/* private mode: the switch still applies for this visit */
	}
	window.dispatchEvent(new Event(EVENT))
}

export function usePreRelease(): boolean {
	const [on, setOn] = useState(readPreRelease)
	useEffect(() => {
		const refresh = () => setOn(readPreRelease())
		window.addEventListener(EVENT, refresh)
		window.addEventListener('storage', refresh)
		return () => {
			window.removeEventListener(EVENT, refresh)
			window.removeEventListener('storage', refresh)
		}
	}, [])
	return on
}
