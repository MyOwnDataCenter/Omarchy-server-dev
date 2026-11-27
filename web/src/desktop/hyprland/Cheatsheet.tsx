const ROWS: [string, string][] = [
	['Scroll Lock / Super+F12', 'Lock keys to this window'],
	['Super+Return', 'Terminal'],
	['Super+Shift+F', 'Files'],
	['Super+Alt+Space', 'Apps'],
	['Super+Space', 'Launcher'],
	['Super+Escape', 'System menu'],
	['Super+K', 'This cheatsheet'],
	['Super+Q / Super+W', 'Close window'],
	['Super+F', 'Fullscreen'],
	['Super+T', 'Toggle float'],
	['Super+J', 'Toggle split'],
	['Super+arrows', 'Focus'],
	['Super+Shift+arrows', 'Swap'],
	['Super+1–9', 'Workspace'],
	['Super+Shift+1–9', 'Move to workspace'],
	['Super+Tab', 'Next workspace'],
	['Super+Shift+Tab', 'Previous workspace'],
	['Super+M', 'Minimize'],
	['Super+Shift+M', 'Restore last minimized'],
]

export function Cheatsheet({onClose}: {onClose: () => void}) {
	return (
		<div className="hypr-overlay" onClick={onClose}>
			<div className="hypr-sheet" role="dialog" aria-label="Keybindings" onClick={(e) => e.stopPropagation()}>
				<header>
					<h2>Keybindings</h2>
					<button className="icon-btn" aria-label="Close" onClick={onClose}>
						×
					</button>
				</header>
				<table>
					<tbody>
						{ROWS.map(([k, v]) => (
							<tr key={k}>
								<th>{k}</th>
								<td>{v}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	)
}
