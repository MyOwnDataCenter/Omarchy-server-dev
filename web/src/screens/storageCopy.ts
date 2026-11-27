// Success text for a pool on this server (Files) or on a swarm computer (~/Pools).
export const ZFS_INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/MyOwnDataCenter/server/main/install.sh | bash -s -- --zfs'

export function poolCreatedToast(name: string, swarm: boolean): string {
	return swarm ? `Pool ${name} is ready. It’s mounted at ~/Pools on this computer.` : `Pool ${name} is ready in Files → Home → Pools`
}

export function poolImportedToast(name: string, swarm: boolean): string {
	return swarm ? `Imported. It’s mounted at ~/Pools on this computer.` : `Imported. It’s in Files → Home → Pools → ${name}`
}
