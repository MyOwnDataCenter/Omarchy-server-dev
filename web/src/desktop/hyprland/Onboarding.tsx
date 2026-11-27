import {useEffect, useState} from 'react'

import {SnippetBlock} from './Snippet'

export function Onboarding({onDismiss}: {onDismiss: () => void}) {
	const [flash, setFlash] = useState(false)
	useEffect(() => {
		// Capture phase: the desktop handles Scroll Lock (the lock toggle) and stops it there, so a
		// listener after it would never hear the key.
		const on = (e: KeyboardEvent) => {
			if (e.code !== 'ScrollLock') return
			setFlash(true)
			window.setTimeout(() => setFlash(false), 600)
		}
		window.addEventListener('keydown', on, true)
		return () => window.removeEventListener('keydown', on, true)
	}, [])
	return (
		<div className="hypr-onboard" role="dialog" aria-label="Hyprland keys">
			<h2>Hyprland keys</h2>
			<p>
				On an Omarchy computer, Super is taken by its own desktop. Paste this into your Hyprland key config, run <code>hyprctl reload</code>, then press Scroll Lock (or
				Super+F12) so Super stays in this browser. The snippet outline lights up when this page sees Scroll Lock.
			</p>
			<SnippetBlock flash={flash} />
			<p>On https:// in Chrome, Edge or Brave, the lock chip on the bar can take Super without the snippet (full screen).</p>
			<div className="hypr-onboard-actions">
				<button className="btn primary" onClick={onDismiss}>
					Got it
				</button>
			</div>
		</div>
	)
}
