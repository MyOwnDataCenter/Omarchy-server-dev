import type {BatteryInfo, BatteryStatus} from './api'

export type CombinedBattery = {
	percent: number | null
	status: BatteryStatus
	secondsRemaining: number | null
}

export function batteryColor(p: number) {
	return p <= 15 ? 'var(--red)' : p <= 25 ? 'var(--yellow)' : 'var(--green)'
}

function sumKnown(xs: Array<number | null>) {
	const known = xs.filter((n): n is number => n != null)
	return known.length ? known.reduce((a, b) => a + b, 0) : null
}

function average(xs: number[]) {
	if (!xs.length) return null
	return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length)
}

function combinedStatus(batteries: BatteryInfo[]): BatteryStatus {
	if (batteries.some((b) => b.status === 'charging')) return 'charging'
	if (batteries.every((b) => b.status === 'full')) return 'full'
	if (batteries.some((b) => b.status === 'discharging')) return 'discharging'
	if (batteries.some((b) => b.status === 'not-charging')) return 'not-charging'
	return 'unknown'
}

function eta(status: BatteryStatus, energyNow: number | null, energyFull: number | null, power: number | null) {
	if (power == null || power <= 0 || energyNow == null) return null
	if (status === 'discharging') return Math.round((energyNow / (power * 1e6)) * 3600)
	if (status === 'charging' && energyFull != null && energyFull > energyNow) return Math.round(((energyFull - energyNow) / (power * 1e6)) * 3600)
	return null
}

export function combineBatteries(batteries: BatteryInfo[]): CombinedBattery | null {
	if (!batteries.length) return null
	if (batteries.length === 1) {
		const b = batteries[0]
		return {percent: b.percent, status: b.status, secondsRemaining: b.secondsRemaining}
	}
	const energyNow = batteries.every((b) => b.energyNow != null) ? sumKnown(batteries.map((b) => b.energyNow)) : null
	const energyFull = batteries.every((b) => b.energyFull != null) ? sumKnown(batteries.map((b) => b.energyFull)) : null
	const power = sumKnown(batteries.map((b) => b.power))
	const percent =
		energyNow != null && energyFull != null && energyFull > 0
			? Math.round((100 * energyNow) / energyFull)
			: average(batteries.map((b) => b.percent).filter((n): n is number => n != null))
	const status = combinedStatus(batteries)
	return {percent, status, secondsRemaining: eta(status, energyNow, energyFull, power)}
}

function formatEta(seconds: number | null) {
	if (seconds == null || seconds < 60) return null
	const d = Math.floor(seconds / 86400)
	const h = Math.floor((seconds % 86400) / 3600)
	const m = Math.floor((seconds % 3600) / 60)
	return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}

export function batterySub(status: BatteryStatus, secondsRemaining: number | null) {
	if (status === 'charging') return 'Charging'
	if (status === 'full') return 'Full'
	if (status === 'discharging') return formatEta(secondsRemaining) ?? 'Discharging'
	if (status === 'not-charging') return 'Not charging'
	return ' '
}

export function batteryPackSub(bat: BatteryInfo) {
	return [bat.name, batterySub(bat.status, bat.secondsRemaining)].filter((s) => s && s !== ' ').join(' · ')
}

export function batteryGaugeItem(batteries: BatteryInfo[]) {
	const combined = combineBatteries(batteries)
	if (!combined) return []
	return [
		{
			k: 'Battery',
			icon: 'battery' as const,
			p: combined.percent ?? 0,
			sub: batterySub(combined.status, combined.secondsRemaining),
			ready: combined.percent != null,
			color: batteryColor(combined.percent ?? 0),
		},
	]
}
