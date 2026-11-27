// Sign-out drops cached account data. Bootstrap stays so the page can show the signed-out screen.
export function queryClearsOnSignOut(queryKey: readonly unknown[]): boolean {
	return queryKey[0] !== 'bootstrap'
}
