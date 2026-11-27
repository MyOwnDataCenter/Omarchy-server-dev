import {useLayoutEffect, useRef} from 'react'

import {fittingCrumbCount} from './fittingCrumbs'

export function FittingCrumbs({crumbs, onOpen}: {crumbs: {name: string; path: string | null}[]; onOpen: (path: string | null) => void}) {
	const nav = useRef<HTMLElement>(null)
	const key = crumbs.map((c) => `${c.path ?? ''}\0${c.name}`).join('\n')
	useLayoutEffect(() => {
		const el = nav.current
		if (!el) return
		const fit = () => {
			const ol = el.querySelector('ol')
			if (!ol) return
			const items = [...ol.children] as HTMLElement[]
			if (!items.length) return
			for (const li of items) li.hidden = false
			const keep = fittingCrumbCount(items.map((li) => li.offsetWidth), el.clientWidth)
			const hideUntil = items.length - keep
			for (let i = 0; i < hideUntil; i++) items[i].hidden = true
		}
		fit()
		const observer = new ResizeObserver(fit)
		observer.observe(el)
		return () => observer.disconnect()
	}, [key])
	return (
		<nav ref={nav} className="nu-path" aria-label="Breadcrumbs">
			<ol>
				{crumbs.map((crumb, i) => {
					const current = i === crumbs.length - 1
					return (
						<li key={`${crumb.path ?? 'files'}-${i}`}>
							<button type="button" aria-current={current ? 'page' : undefined} onClick={() => onOpen(crumb.path)}>
								{crumb.name}
							</button>
						</li>
					)
				})}
			</ol>
		</nav>
	)
}
