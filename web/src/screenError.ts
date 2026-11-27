export const SCREEN_LOAD_ERROR = "This screen couldn't load"

export function caughtScreenError(error: unknown): {error: unknown} {
	return {error}
}

export function screenErrorView(state: {error: unknown}): {message: string; retryLabel: string} | null {
	if (state.error == null) return null
	return {message: SCREEN_LOAD_ERROR, retryLabel: 'Try again'}
}

export function retryScreen<T extends {retry: number}>(state: T): Omit<T, 'error' | 'retry'> & {error: null; retry: number} {
	return {...state, error: null, retry: state.retry + 1}
}
