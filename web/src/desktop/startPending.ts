// True when this machine's start has been sent and not recorded yet, or a watch is already waiting.
export function startAlreadyPending(inFlight: ReadonlySet<string> | readonly string[], watches: readonly {id: string}[], id: string): boolean {
	const flying = inFlight instanceof Set ? inFlight.has(id) : (inFlight as readonly string[]).includes(id)
	return flying || watches.some((watch) => watch.id === id)
}
