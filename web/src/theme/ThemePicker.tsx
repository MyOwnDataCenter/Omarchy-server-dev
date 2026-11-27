import {memo} from 'react'

import {matchThemeName, sameThemePicker} from '../swarm/themePicker'

// The theme control for a joined computer. The server's own themes stay in Settings → Appearance.
export const ThemePicker = memo(
	function ThemePicker({themes, theme, disabled, onPick}: {themes: string[]; theme: string; disabled: boolean; onPick: (theme: string) => void}) {
		const current = matchThemeName(themes, theme)
		if (!themes.length) return <span className="muted">{current || '–'}</span>
		return (
			<select aria-label="Theme" value={current} disabled={disabled} onChange={(e) => e.target.value && onPick(e.target.value)} style={{maxWidth: 170}}>
				{!themes.includes(current) && <option value="">{current || 'Choose…'}</option>}
				{themes.map((t) => (
					<option key={t}>{t}</option>
				))}
			</select>
		)
	},
	(prev, next) => sameThemePicker(prev, next),
)
