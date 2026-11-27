import type {ReactNode} from 'react'

import {Icon} from '../icons'
import {haptic} from '../ui'

/** Terminal is the shell. Desktop is the machine’s screen. Shared by this server, a joined computer, and a guest. */
export function MachineActions({terminal, desktop, onTerminal, onDesktop, pin}: {terminal: boolean; desktop: boolean; onTerminal: () => void; onDesktop: () => void; pin?: ReactNode}) {
	return (
		<div className="primary-row">
			<button type="button" className="btn primary" disabled={!terminal} onClick={() => (haptic(8), onTerminal())}>
				<Icon name="terminal" size={20} /> Terminal
			</button>
			<button type="button" className="btn" disabled={!desktop} onClick={() => (haptic(8), onDesktop())}>
				<Icon name="devices" size={20} /> Desktop
			</button>
			{pin}
		</div>
	)
}
