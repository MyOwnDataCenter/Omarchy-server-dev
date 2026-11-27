// What the Terminal says when its connection closes. A shell that was never reached is not "still
// running", so that line is only for a connection that had been working and dropped.
export type TerminalClose = {state: 'closed' | 'lost' | 'error'; message: string}

export function terminalCloseOutcome({opened, shellEnded, onComputer}: {opened: boolean; shellEnded: boolean; onComputer: boolean}): TerminalClose {
	if (shellEnded) return {state: 'closed', message: 'The shell has ended.'}
	if (!opened) return {state: 'error', message: 'Couldn’t open the terminal. Check that it is running, then try again.'}
	return {state: 'lost', message: onComputer ? 'Your shell is still running on that computer. Reconnect to pick up where you left off.' : 'Your shell is still running on the server. Reconnect to pick up where you left off.'}
}
