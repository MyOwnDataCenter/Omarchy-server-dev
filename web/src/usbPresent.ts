export function showUnplugged(device: {present?: boolean; path?: string | null}) {
	return device.present === false
}
