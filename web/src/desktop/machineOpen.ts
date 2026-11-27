export function desktopMachineStatus(state: string | undefined): 'running' | 'stopped' | 'busy' | undefined {
	if (!state) return undefined
	if (state === 'running') return 'running'
	if (state === 'stopped' || state === 'error' || state === 'hibernated') return 'stopped'
	return 'busy'
}

export function machineOpenAction(state: string): 'open' | 'start' | 'wait' {
	if (state === 'running') return 'open'
	if (state === 'stopped' || state === 'error' || state === 'suspended' || state === 'hibernated') return 'start'
	return 'wait'
}
