// The in-flight assistant turn lives here, not on the screen. Closing the window must not abort
// the model; New session still does. Unread counts replies that finished while the chat was closed.
import {useSyncExternalStore} from 'react'

// Node's test loader needs the .ts suffix; web/tsconfig allowImportingTsExtensions matches that.
import {resetAssistantActivity, setAssistantActivity} from './assistantActivity.ts'
import type {AssistantItem} from './assistant.ts'

export type AssistantTurn = {
	open: boolean
	streaming: boolean
	unread: number
	items: AssistantItem[] | null
	activity: string | null
	error: string | null
	conversationId?: string
}

const empty = (): AssistantTurn => ({open: false, streaming: false, unread: 0, items: null, activity: null, error: null})

let controller: AbortController | null = null
let state: AssistantTurn = empty()
const listeners = new Set<() => void>()
// Sign-out bumps this. A send, approve, or follow-up keeps the value it started with.
let epoch = 0
const approveAborts = new Set<AbortController>()

export function assistantEpoch() {
	return epoch
}

// decide() registers its own controller here. Reset aborts it with the turn.
export function registerAssistantAbort(ac: AbortController) {
	approveAborts.add(ac)
	return () => {
		approveAborts.delete(ac)
	}
}

function emit(next: AssistantTurn) {
	state = next
	for (const l of listeners) l()
}

function set(next: AssistantTurn) {
	if (
		next.open === state.open
		&& next.streaming === state.streaming
		&& next.unread === state.unread
		&& next.items === state.items
		&& next.activity === state.activity
		&& next.error === state.error
		&& next.conversationId === state.conversationId
	) return
	emit(next)
}

export function assistantTurn() {
	return state
}

export function resetAssistantTurn() {
	epoch += 1
	controller?.abort()
	controller = null
	for (const ac of approveAborts) ac.abort()
	approveAborts.clear()
	emit(empty())
	resetAssistantActivity()
}

function syncPhase() {
	const items = state.items ?? []
	const live = items.find((b) => b.kind === 'text' && b.streaming)
	const cards = items.filter((b) => b.kind === 'card')
	const running = cards.some((c) => c.kind === 'card' && c.action.status === 'running')
	const pending = cards.filter((c) => c.kind === 'card' && c.action.status === 'pending').length
	const liveText = live && live.kind === 'text' ? live : null
	const phase = state.error
		? 'error'
		: running || (liveText && state.activity)
			? 'working'
			: liveText
				? liveText.content
					? 'responding'
					: 'thinking'
				: state.streaming
					? 'thinking'
					: 'idle'
	setAssistantActivity({phase, pending})
}

export function beginAssistantTurn(ac: AbortController, since?: number) {
	if (since !== undefined && since !== epoch) return
	if (controller && controller !== ac) controller.abort()
	controller = ac
	set({...state, streaming: true, error: null})
	syncPhase()
}

export function closeAssistantView() {
	set({...state, open: false})
	setAssistantActivity({open: false, composing: false, ...(state.streaming ? {} : {phase: 'idle'})})
}

// Super+W / the window X must not unmount the chat while a turn is still talking to the model.
export function keepAssistantWindow(kind?: string) {
	if (!state.streaming) return false
	return kind == null || kind === 'assistant'
}

export function openAssistantView() {
	set({...state, open: true, unread: 0})
	setAssistantActivity({open: true})
}

export function finishAssistantTurn(ac?: AbortController, since?: number) {
	if (since !== undefined && since !== epoch) return
	if (ac && controller !== ac) return
	controller = null
	const unread = state.open ? state.unread : state.unread + 1
	set({...state, streaming: false, unread, activity: null})
	setAssistantActivity({phase: state.error ? 'error' : 'idle'})
}

export function abortAssistantTurn() {
	controller?.abort()
	controller = null
	set({...state, streaming: false, activity: null})
	setAssistantActivity({phase: 'idle'})
}

export function setTurnItems(update: AssistantItem[] | null | ((prev: AssistantItem[] | null) => AssistantItem[] | null)) {
	const items = typeof update === 'function' ? update(state.items) : update
	set({...state, items})
	syncPhase()
}

export function setTurnActivity(activity: string | null) {
	set({...state, activity})
	syncPhase()
}

export function setTurnError(error: string | null) {
	set({...state, error})
	syncPhase()
}

export function setTurnConversationId(conversationId: string | undefined, since?: number) {
	if (since !== undefined && since !== epoch) return
	set({...state, conversationId})
}

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l))
export const useAssistantTurn = () => useSyncExternalStore(subscribe, assistantTurn, assistantTurn)
