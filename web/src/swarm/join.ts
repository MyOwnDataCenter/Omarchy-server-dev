// Which computer appeared after Add a computer opened. `beforeIds` must be the snapshot
// from that moment: if it tracks the live swarm list, the new computer is never "new".
export function newlyJoined<T extends {id: string}>(agents: T[], beforeIds: readonly string[]): T | undefined {
	return agents.find((a) => !beforeIds.includes(a.id))
}
