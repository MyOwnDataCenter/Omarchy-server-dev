// One icon per app across the fleet. The order is the order the instances arrived,
// so a server that is the only place keeps the list the server already returned.

export type AppInstance = {
	appId: string
	name: string
	computerId: string
	computerName: string
}

export type AppGroup = {
	appId: string
	name: string
	instances: AppInstance[]
}

export function groupApps(instances: readonly AppInstance[]): AppGroup[] {
	const groups: AppGroup[] = []
	for (const row of instances) {
		const found = groups.find((g) => g.appId === row.appId)
		if (found) found.instances.push(row)
		else groups.push({appId: row.appId, name: row.name || row.appId, instances: [row]})
	}
	for (const group of groups) group.instances.sort((a, b) => a.computerName.localeCompare(b.computerName) || a.computerId.localeCompare(b.computerId))
	return groups
}
