// The project moved on GitHub: the TouchWorkStation account is now MyOwnDataCenter, and its
// omarchy-server repository is now MyOwnDataCenter/server. GitHub redirects the old addresses only
// until someone else takes the old name, so servers move their own saved addresses over (once).
export const GITHUB_OWNER = 'MyOwnDataCenter'
const RENAMED = {'omarchy-server': 'server'}

/** The new GitHub address for a repository under the old account, in the same form (https or
 *  ssh, with or without .git); null for anything else. */
export function movedGithubUrl(url) {
	const text = String(url ?? '').trim()
	const m = /^(https:\/\/(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)touchworkstation\/([A-Za-z0-9_.-]+?)(\.git)?(\/?)$/i.exec(text)
	if (!m) return null
	const repo = RENAMED[m[2].toLowerCase()] ?? m[2]
	return `${m[1].replace(/www\./i, '')}${GITHUB_OWNER}/${repo}${m[3] ?? ''}${m[4]}`
}
