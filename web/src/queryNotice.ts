export function errorText(error: unknown): string {
	if (error instanceof Error && error.message) return error.message
	if (typeof error === 'string' && error) return error
	if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message) return error.message
	return 'Lost contact with your server. Retrying…'
}
