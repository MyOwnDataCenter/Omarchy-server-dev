// Dashboard pins stay on this browser. They are not a server setting.

export type PinKind = 'machine' | 'vm' | 'app'

export type DashboardPin = {
	kind: PinKind
	id: string
	/** Empty for a physical computer. A guest or an app names the computer it belongs to. */
	computer: string
}

export const PINS_KEY = 'omarchy-server:pins'

export function pinKey(pin: DashboardPin) {
	return `${pin.kind}:${pin.computer}:${pin.id}`
}

function isPin(value: unknown): value is DashboardPin {
	if (!value || typeof value !== 'object') return false
	const pin = value as DashboardPin
	return (pin.kind === 'machine' || pin.kind === 'vm' || pin.kind === 'app') && typeof pin.id === 'string' && pin.id.length > 0 && typeof pin.computer === 'string'
}

export function loadPins(raw: string | null): DashboardPin[] {
	if (!raw) return []
	try {
		const data = JSON.parse(raw) as unknown
		if (!Array.isArray(data)) return []
		return data.filter(isPin)
	} catch {
		return []
	}
}

export function hasPin(pins: readonly DashboardPin[], pin: DashboardPin) {
	const key = pinKey(pin)
	return pins.some((row) => pinKey(row) === key)
}

export function togglePin(pins: readonly DashboardPin[], pin: DashboardPin): DashboardPin[] {
	const key = pinKey(pin)
	if (pins.some((row) => pinKey(row) === key)) return pins.filter((row) => pinKey(row) !== key)
	return [...pins, {kind: pin.kind, id: pin.id, computer: pin.computer}]
}
