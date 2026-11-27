// One way to change a machine's theme.
// This server's Omarchy theme drives the app's colours and wallpaper.
// A joined computer is themed on its own, through the connector, and only when it runs Omarchy.
// A guest waits until its connector is installed and that operating system supports themes.

export type ThemeCall = {path: string; input: Record<string, string>}

export function themeAction(target: {kind: 'server'; slug: string} | {kind: 'computer'; id: string; theme: string} | {kind: 'guest'; name: string}): ThemeCall | {error: string} {
	if (target.kind === 'guest') return {error: `Install the connector on ${target.name} before its theme can be changed, and only when that operating system supports themes.`}
	if (target.kind === 'server') return {path: 'omarchy.setTheme', input: {slug: target.slug}}
	return {path: 'swarm.action', input: {id: target.id, name: 'theme-set', theme: target.theme}}
}
