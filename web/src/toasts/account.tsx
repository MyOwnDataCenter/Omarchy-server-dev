// Account toasts for this person. The box at the top, or the assistant's bubble, both read this list.
import {useQuery, useQueryClient} from '@tanstack/react-query'
import {createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode} from 'react'

import {mutate, query} from '../api'
import {Icon} from '../icons'
import {openToastPlace} from './open'
import {liveToasts, spokenToast, type ToastRecord} from './view'

export const TOASTS_QUERY_KEY = ['toasts.list'] as const

type Boot = {session?: unknown; server?: {reachable?: boolean}} | null

type ToastApi = {
	rows: ToastRecord[]
	spoken: ToastRecord | null
	bubble: boolean
	claimBubble: (on: boolean) => void
	dismiss: (id: string) => void
	open: (row: ToastRecord) => void
}

const EMPTY: ToastApi = {
	rows: [],
	spoken: null,
	bubble: false,
	claimBubble: () => {},
	dismiss: () => {},
	open: () => {},
}

const Ctx = createContext<ToastApi>(EMPTY)

export function useAccountToasts() {
	return useContext(Ctx)
}

function signedInFrom(data: unknown) {
	const boot = data as Boot
	return !!boot?.session && !!boot?.server?.reachable
}

function useSignedIn() {
	const qc = useQueryClient()
	const [signedIn, setSignedIn] = useState(() => signedInFrom(qc.getQueryData(['bootstrap'])))
	useEffect(() => {
		const read = () => setSignedIn(signedInFrom(qc.getQueryData(['bootstrap'])))
		read()
		return qc.getQueryCache().subscribe((event) => {
			if (event.query.queryKey[0] !== 'bootstrap') return
			read()
		})
	}, [qc])
	return signedIn
}

export function AccountToastProvider({children}: {children: ReactNode}) {
	const qc = useQueryClient()
	const signedIn = useSignedIn()
	const list = useQuery({
		queryKey: TOASTS_QUERY_KEY,
		queryFn: () => query<ToastRecord[]>('toasts.list'),
		enabled: signedIn,
		refetchInterval: signedIn ? 2500 : false,
		retry: false,
	})
	const raw = list.data
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		if (!raw?.length) return
		const soon = raw.reduce<number>((at, row) => (row.expireAt != null && row.expireAt < at ? row.expireAt : at), Infinity)
		if (!Number.isFinite(soon)) return
		const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, soon - Date.now()) + 30)
		return () => window.clearTimeout(timer)
	}, [raw])
	const rows = liveToasts(raw ?? [], now)
	const spoken = spokenToast(raw ?? [], now)
	const [bubble, setBubble] = useState(false)
	const claimBubble = useCallback((on: boolean) => setBubble(on), [])
	const dismiss = useCallback(
		(id: string) => {
			qc.setQueryData<ToastRecord[]>(TOASTS_QUERY_KEY, (current) => (current ?? []).filter((row) => row.id !== id))
			void mutate('toasts.dismiss', {id}).catch(() => {
				void qc.invalidateQueries({queryKey: TOASTS_QUERY_KEY})
			})
		},
		[qc],
	)
	const open = useCallback(
		(row: ToastRecord) => {
			if (row.href) openToastPlace(row.href)
			dismiss(row.id)
		},
		[dismiss],
	)
	const value = useMemo(() => ({rows, spoken, bubble, claimBubble, dismiss, open}), [rows, spoken, bubble, claimBubble, dismiss, open])
	const heard = spoken?.level === 'problem' ? 'assertive' : 'polite'
	return (
		<Ctx.Provider value={value}>
			{children}
			<div className="sr-only" role={spoken?.level === 'problem' ? 'alert' : 'status'} aria-live={heard} aria-atomic="true">
				{spoken?.text ?? ''}
			</div>
		</Ctx.Provider>
	)
}

type LocalToast = {id: number; text: string; error?: boolean}

export function AccountToastStack({local}: {local: LocalToast | null}) {
	const {rows, bubble, dismiss, open} = useAccountToasts()
	const account = bubble ? [] : rows
	if (!local && account.length === 0) return null
	return (
		<div className="toast-stack">
			{account.map((row) => (
				<div key={row.id} className={`toast${row.level === 'problem' ? ' error' : ''}`}>
					<span className="ico">
						<Icon name={row.level === 'problem' ? 'alert' : 'check'} size={15} stroke={2.6} />
					</span>
					{row.href ? (
						<button type="button" className="toast-open" onClick={() => open(row)}>
							{row.text}
						</button>
					) : (
						<span className="toast-text">{row.text}</span>
					)}
					<button type="button" className="toast-x" aria-label="Dismiss" onClick={() => dismiss(row.id)}>
						<Icon name="close" size={14} />
					</button>
				</div>
			))}
			{local && (
				<div key={local.id} className={`toast${local.error ? ' error' : ''}`} aria-hidden="true">
					<span className="ico">
						<Icon name={local.error ? 'alert' : 'check'} size={15} stroke={2.6} />
					</span>
					{local.text}
				</div>
			)}
		</div>
	)
}
