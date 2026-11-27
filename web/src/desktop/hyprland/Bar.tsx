import {Icon} from '../../icons'

export function WorkspacePills({
	current,
	occupied,
	minimized,
	onSwitch,
	onMenu,
}: {
	current: number
	occupied: Set<number>
	minimized: Set<number>
	onSwitch: (n: number) => void
	onMenu: () => void
}) {
	return (
		<div className="hypr-ws">
			<button type="button" className="hypr-menu" aria-label="Launcher" title="Launcher" onClick={onMenu}>
				<Icon name="show-apps" size={16} />
			</button>
			<div className="hypr-pills" role="tablist" aria-label="Workspaces">
			{Array.from({length: 9}, (_, i) => i + 1).map((n) => {
				const on = n === current
				const has = occupied.has(n)
				const min = minimized.has(n)
				return (
					<button
						key={n}
						role="tab"
						aria-selected={on}
						aria-label={`Workspace ${n}`}
						className={`hypr-pill${on ? ' on' : ''}${has ? ' occ' : ''}${min && !has ? ' min' : ''}`}
						onClick={() => onSwitch(n)}
					>
						{n}
					</button>
				)
			})}
			</div>
		</div>
	)
}

export function LockChip({locked, onClick, title}: {locked: boolean; onClick: () => void; title: string}) {
	return (
		<button className={`hypr-lock${locked ? ' on' : ''}`} onClick={onClick} aria-pressed={locked} aria-label={locked ? 'Keys locked to this window' : 'Lock keys to this window'} title={title}>
			<Icon name={locked ? 'key' : 'lock-open'} size={15} />
			{locked ? 'Locked' : 'Lock keys'}
		</button>
	)
}
