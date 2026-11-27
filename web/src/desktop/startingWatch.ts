export type StartingWatch = {id: string; listUpdatedAt: number}

// listUpdatedAt is the machines.list stamp when start() returned. stopped/error on
// that same stamp is still the pre-start list, so the watch keeps going. A later
// stamp that is stopped, error, or missing ends it. running opens the console on
// any stamp, including the one taken as start() returned.
export function nextStarting(
	watches: StartingWatch[],
	machines: {id: string; state: string}[] | undefined,
	listUpdatedAt: number,
): {keep: StartingWatch[]; open: string[]} {
	if (!machines) return {keep: watches, open: []}
	const keep: StartingWatch[] = []
	const open: string[] = []
	for (const watch of watches) {
		const machine = machines.find((m) => m.id === watch.id)
		if (!machine) continue
		if (machine.state === 'running') {
			open.push(watch.id)
			continue
		}
		const fresh = listUpdatedAt > watch.listUpdatedAt
		if (fresh && (machine.state === 'error' || machine.state === 'stopped')) continue
		keep.push(watch)
	}
	return {keep, open}
}
