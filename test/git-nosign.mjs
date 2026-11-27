// Test repos must not sign commits or run the developer's git hooks.
export const GIT_NOSIGN = ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null']

export function gitArgv(args) {
	return [...GIT_NOSIGN, ...args]
}
