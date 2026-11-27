// What the assistant is doing right now, for its character. Written only by the existing assistant
// screen, from state it already has (streamed text, tool lookups, Approve cards, errors). It never
// changes what the assistant does, and nothing here is sent anywhere.
import {useEffect, useState, useSyncExternalStore} from 'react'

export type AssistantPhase = 'idle' | 'thinking' | 'responding' | 'working' | 'error'
export type AssistantActivity = {
	phase: AssistantPhase
	/** Approve cards waiting for you. */
	pending: number
	/** The message box has focus (there's no voice input, so this is "listening"). */
	composing: boolean
	/** When an Approve last came back done from the server (confirmed, never assumed). */
	successAt: number
	/** Last time anything happened, for sleeping. */
	activeAt: number
	/** The assistant screen or window is open. */
	open: boolean
}

function idleActivity(): AssistantActivity {
	return {phase: 'idle', pending: 0, composing: false, successAt: 0, activeAt: Date.now(), open: false}
}

let state: AssistantActivity = idleActivity()
const listeners = new Set<() => void>()

// Sign-out drops the previous person's activity. Always notify, even when the values already match.
export function resetAssistantActivity() {
	state = idleActivity()
	for (const l of listeners) l()
}

export function setAssistantActivity(patch: Partial<AssistantActivity>) {
	const next = {...state, ...patch}
	if (patch.phase && patch.phase !== 'idle') next.activeAt = Date.now()
	if (patch.composing || patch.open || patch.successAt) next.activeAt = Date.now()
	if ((Object.keys(next) as (keyof AssistantActivity)[]).every((k) => next[k] === state[k])) return
	state = next
	for (const l of listeners) l()
}
export const assistantActivity = () => state
const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l))
export const useAssistantActivity = () => useSyncExternalStore(subscribe, assistantActivity, assistantActivity)

// The character's state, from the activity above plus pointer hover, in order of importance. Success
// shows only for a moment after a confirmed Approve; sleeping only after a long quiet spell.
export type CharacterState = 'idle' | 'hover' | 'listening' | 'thinking' | 'responding' | 'working' | 'success' | 'error' | 'sleeping'
export const SUCCESS_MS = 2600
export const SLEEP_MS = 10 * 60_000

export function characterState(a: AssistantActivity, {hover = false, reactions = true, now = Date.now()} = {}): CharacterState {
	if (!reactions) return hover ? 'hover' : 'idle'
	if (a.phase === 'error') return 'error'
	if (a.successAt && now - a.successAt < SUCCESS_MS) return 'success'
	if (a.phase === 'working') return 'working'
	if (a.phase === 'responding') return 'responding'
	if (a.phase === 'thinking') return 'thinking'
	if (a.composing) return 'listening'
	if (hover) return 'hover'
	if (!a.open && a.pending === 0 && now - a.activeAt > SLEEP_MS) return 'sleeping'
	return 'idle'
}

// The hook the character components use: re-checks the clock for success ending and sleep starting.
export function useAssistantAnimationState({hover = false, reactions = true}: {hover?: boolean; reactions?: boolean} = {}): CharacterState {
	const a = useAssistantActivity()
	const [now, setNow] = useState(() => Date.now())
	useEffect(() => {
		const success = a.successAt ? a.successAt + SUCCESS_MS - Date.now() : -1
		const sleep = a.activeAt + SLEEP_MS - Date.now()
		const wait = [success, sleep].filter((ms) => ms > 0)
		if (!wait.length) return
		const t = window.setTimeout(() => setNow(Date.now()), Math.min(...wait) + 50)
		return () => window.clearTimeout(t)
	}, [a.successAt, a.activeAt, now])
	return characterState(a, {hover, reactions, now})
}
