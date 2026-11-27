import {useState} from 'react'

import {batterySweep, type BatteryGroup, type BatteryMember} from './aggregate'

// The home battery ring. Arcs share one radius and start at 12 o'clock.
// The longest is painted first so a shorter arc covers only its own length.
export function BatteryRing({groups, lowest, size = 84, color}: {groups: BatteryGroup[]; lowest: BatteryMember; size?: number; color?: string}) {
	const stroke = 8
	const r = (size - stroke) / 2
	const [hot, setHot] = useState<string | null>(null)
	const active = groups.find((g) => g.id === hot) ?? null
	const tip = active ? batterySweep(active.percent, size, stroke) : null
	return (
		<div className="ring bat-ring" style={{width: size, height: size, color}} role="img" aria-label={`Battery, lowest ${lowest.name} ${Math.round(lowest.percent)}%`}>
			<svg viewBox={`0 0 ${size} ${size}`} aria-hidden="true" onPointerLeave={() => setHot(null)}>
				<circle className="track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} />
				<defs>
					{groups
						.filter((g) => g.members.length > 1)
						.map((g) => (
							<linearGradient id={`bat-${g.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`} key={g.id} x1="0" y1="0" x2="1" y2="1">
								{g.members.map((m, i) => (
									<stop key={m.id} offset={`${g.members.length === 1 ? 0 : (i / (g.members.length - 1)) * 100}%`} stopColor={m.color} />
								))}
							</linearGradient>
						))}
				</defs>
				{groups.map((g) => {
					const sweep = batterySweep(g.percent, size, stroke)
					const strokeColor = g.members.length > 1 ? `url(#bat-${g.id.replace(/[^a-zA-Z0-9_-]/g, '-')})` : g.members[0].color
					const label = g.members.map((m) => `${m.name} ${Math.round(m.percent)}%`).join(', ')
					if (sweep.full) {
						return <circle key={g.id} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={strokeColor} strokeWidth={stroke} onPointerOver={() => setHot(g.id)}>
							<title>{label}</title>
						</circle>
					}
					return (
						<path key={g.id} d={sweep.d} fill="none" stroke={strokeColor} strokeWidth={stroke} strokeLinecap="round" onPointerOver={() => setHot(g.id)}>
							<title>{label}</title>
						</path>
					)
				})}
			</svg>
			<div className="center">
				<span className="pct">
					{Math.round(lowest.percent)}
					<small>%</small>
				</span>
			</div>
			{active && tip && (
				<span className={`bat-tip${tip.endLeft ? ' is-left' : ''}`} style={{left: tip.endX, top: tip.endY}}>
					{active.members.map((m) => (
						<span key={m.id}>
							{m.name} {Math.round(m.percent)}%
						</span>
					))}
				</span>
			)}
		</div>
	)
}
