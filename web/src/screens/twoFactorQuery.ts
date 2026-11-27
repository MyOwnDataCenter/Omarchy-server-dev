import type {QueryClient} from '@tanstack/react-query'

// Drop the cached authenticator setup key when the sheet closes or two-factor changes.
// While the sheet stays open the query is left alone, so the code the app shows still matches.
export function clearTotpSetupQuery(qc: QueryClient, reason: 'close' | 'success') {
	if (reason !== 'close' && reason !== 'success') return
	qc.removeQueries({queryKey: ['user.generateTotpUri']})
}
