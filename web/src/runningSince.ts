// Tooltip on the version tag: how long this omarchyd has been up, and which git revision it is.
export function formatRunningSince(
	startedAt?: number,
	{now = Date.now(), revision, locale, timeZone}: {now?: number; revision?: string; locale?: string; timeZone?: string} = {},
): string {
	const parts: string[] = []
	if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
		const s = Math.max(0, (now - startedAt) / 1000)
		let duration: string
		if (s < 60) duration = 'less than a minute'
		else {
			// Round to the current unit first, then promote 60 minutes to 1 hour and 24 hours to 1 day.
			const minutes = Math.max(1, Math.round(s / 60))
			if (minutes < 60) duration = minutes === 1 ? '1 minute' : `${minutes} minutes`
			else {
				const hours = Math.max(1, Math.round(minutes / 60))
				if (hours < 24) duration = hours === 1 ? '1 hour' : `${hours} hours`
				else {
					const days = Math.max(1, Math.round(hours / 24))
					duration = days === 1 ? '1 day' : `${days} days`
				}
			}
		}
		const when = new Intl.DateTimeFormat(locale, {
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
			...(timeZone ? {timeZone} : {}),
		}).format(new Date(startedAt))
		parts.push(`Running ${duration} (since ${when})`)
	}
	if (revision) parts.push(`Revision ${revision}`)
	return parts.length ? `${parts.join('. ')}.` : ''
}

export type VersionInfo = {startedAt?: number; revision?: string}

export function versionTagProps(
	version?: string,
	info?: VersionInfo | null,
	{
		prefix = '',
		now,
		locale,
		timeZone,
	}: {prefix?: string; now?: number; locale?: string; timeZone?: string} = {},
): {text: string; title?: string; ariaLabel?: string} {
	const text = `${prefix}${version ?? '–'}`
	const title = formatRunningSince(info?.startedAt, {revision: info?.revision, now, locale, timeZone}) || undefined
	return title ? {text, title, ariaLabel: `${text}. ${title}`} : {text}
}
