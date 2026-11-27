// Assistant screen rules: turn gating while a reply is streaming, reopening after a reload,
// minimizing on desktop, and recovering from failed approval requests.
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test} from 'node:test'

import {consumeReopenAssistant, markReopenAssistant} from '../web/src/assistant.ts'
import {assistantActivity, characterState, SLEEP_MS} from '../web/src/assistantActivity.ts'
import {
	canDecideAssistantAction,
	canSendAssistantMessage,
	canStartAssistantFollow,
	isApprovalRequestError,
	resolveFailedDecision,
} from '../web/src/assistantLive.ts'
import {
	assistantTurn,
	beginAssistantTurn,
	closeAssistantView,
	finishAssistantTurn,
	openAssistantView,
	resetAssistantTurn,
} from '../web/src/assistantTurn.ts'

test('sending is disabled while a reply is being written or an approval is running', () => {
	assert.equal(canSendAssistantMessage({draft: 'hello', itemsLoaded: true, streaming: false, decidingCount: 0}), true)
	assert.equal(canSendAssistantMessage({draft: 'hello', itemsLoaded: true, streaming: true, decidingCount: 0}), false)
	assert.equal(canSendAssistantMessage({draft: 'hello', itemsLoaded: true, streaming: false, decidingCount: 1}), false)
	assert.equal(canSendAssistantMessage({draft: '   ', itemsLoaded: true, streaming: false, decidingCount: 0}), false)
	assert.equal(canSendAssistantMessage({draft: 'hello', itemsLoaded: false, streaming: false, decidingCount: 0}), false)
})

test('approve and reject wait while a reply is still streaming', () => {
	assert.equal(canDecideAssistantAction({status: 'pending', streaming: false}), true)
	assert.equal(canDecideAssistantAction({status: 'pending', streaming: true}), false)
	assert.equal(canDecideAssistantAction({status: 'running', streaming: false}), false)
	assert.equal(canDecideAssistantAction({status: 'done', streaming: false}), false)
	assert.equal(canDecideAssistantAction({status: 'rejected', streaming: false}), false)
	assert.equal(canDecideAssistantAction({status: 'error', streaming: false}), false)
})

test('follow-up turns wait until no reply or approval is running', () => {
	assert.equal(canStartAssistantFollow({pumping: false, decidingCount: 0, followQueued: true, streaming: false}), true)
	assert.equal(canStartAssistantFollow({pumping: false, decidingCount: 0, followQueued: true, streaming: true}), false)
	assert.equal(canStartAssistantFollow({pumping: true, decidingCount: 0, followQueued: true, streaming: false}), false)
	assert.equal(canStartAssistantFollow({pumping: false, decidingCount: 1, followQueued: true, streaming: false}), false)
	assert.equal(canStartAssistantFollow({pumping: false, decidingCount: 0, followQueued: false, streaming: false}), false)
})

function stubStorage() {
	const map = new Map()
	return {
		getItem: (k) => (map.has(k) ? map.get(k) : null),
		setItem: (k, v) => void map.set(k, String(v)),
		removeItem: (k) => void map.delete(k),
	}
}

test('reopen-assistant flag survives re-renders before reload and is consumed once on reload', async () => {
	const prevLocal = globalThis.localStorage
	const prevSession = globalThis.sessionStorage
	globalThis.localStorage = stubStorage()
	globalThis.sessionStorage = stubStorage()
	try {
		// Initial page load consumes once into a lazy ref.
		const ref = {current: null}
		const readLazy = () => {
			if (ref.current === null) ref.current = consumeReopenAssistant()
			return ref.current
		}
		assert.equal(readLazy(), false)

		// Approving a wallpaper marks the flag and triggers an App re-render before reload.
		markReopenAssistant()
		assert.equal(readLazy(), false)

		// After reload, the next fresh load sees the flag once and clears it.
		assert.equal(consumeReopenAssistant(), true)
		assert.equal(consumeReopenAssistant(), false)
	} finally {
		globalThis.localStorage = prevLocal
		globalThis.sessionStorage = prevSession
	}

	const appSrc = await readFile(new URL('../web/src/App.tsx', import.meta.url), 'utf8')
	assert.equal(appSrc.includes('useRef(consumeReopenAssistant())'), false, 'App must not consume the flag on every render')
})

test('minimizing the Assistant window lets finished replies count as unread and the character sleep', async () => {
	resetAssistantTurn()
	openAssistantView()
	const ac = new AbortController()
	beginAssistantTurn(ac)
	// Minimizing closes the assistant view without aborting the live turn.
	closeAssistantView()
	assert.equal(ac.signal.aborted, false)
	assert.equal(assistantTurn().open, false)
	assert.equal(assistantActivity().open, false)

	finishAssistantTurn(ac)
	assert.equal(assistantTurn().unread, 1)
	assert.equal(characterState(assistantActivity(), {now: assistantActivity().activeAt + SLEEP_MS + 1}), 'sleeping')

	// Restoring the window marks the view open again and clears unread.
	openAssistantView()
	assert.equal(assistantTurn().open, true)
	assert.equal(assistantTurn().unread, 0)

	const deskSrc = await readFile(new URL('../web/src/desktop/Desktop.tsx', import.meta.url), 'utf8')
	const minBlock = deskSrc.match(/const minimize = useCallback\([\s\S]*?\}, \[update\]\)/)?.[0] ?? ''
	assert.match(minBlock, /kind === 'assistant'[\s\S]*closeAssistantView\(\)/, 'Desktop minimize closes the assistant view')
})

const sampleAction = (status = 'running', extra = {}) => ({
	id: 'act-1',
	status,
	kind: 'rpc',
	toolName: 'apps_update',
	title: 'Update Home Assistant',
	detail: '',
	...extra,
})

test('request errors are distinguished from step errors returned by omarchyd', () => {
	assert.equal(isApprovalRequestError({isApiError: false}), true)
	assert.equal(isApprovalRequestError({isApiError: true, code: 'UNREACHABLE', status: 502}), true)
	assert.equal(isApprovalRequestError({isApiError: true, code: 'BAD_RESPONSE', status: 502}), true)
	assert.equal(isApprovalRequestError({isApiError: true, code: 'ERROR', status: 504}), true)
	assert.equal(isApprovalRequestError({isApiError: true, code: 'BAD_REQUEST', status: 400}), true)
	assert.equal(isApprovalRequestError({isApiError: true, code: 'BAD_GATEWAY', status: 502}), false)
	assert.equal(isApprovalRequestError({isApiError: true, code: 'FORBIDDEN', status: 403}), false)
	assert.equal(isApprovalRequestError({isApiError: true, code: 'PRECONDITION_FAILED', status: 412}), false)
})

test('a timed-out or dropped approval request uses the server’s real status instead of a fake final error', () => {
	const timeout = {isApiError: true, code: 'UNREACHABLE', status: 502, message: "Can't reach Omarchy Server at http://127.0.0.1:2021 (timed out)"}

	// Server finished the step: card becomes done and triggers follow-up.
	const done = resolveFailedDecision(sampleAction('running'), timeout, sampleAction('done'))
	assert.equal(done.action.status, 'done')
	assert.equal(done.banner, null)
	assert.equal(done.follow, true)

	// Server is still running the step: keep it running and show the connection error in the banner.
	const running = resolveFailedDecision(sampleAction('running'), timeout, sampleAction('running'))
	assert.equal(running.action.status, 'running')
	assert.equal(running.banner, timeout.message)
	assert.equal(running.follow, false)

	// Server never started it (still pending) or could not be reached: revert to pending so Approve returns.
	const pending = resolveFailedDecision(sampleAction('running'), timeout, sampleAction('pending'))
	assert.equal(pending.action.status, 'pending')
	assert.equal(pending.banner, timeout.message)
	assert.equal(pending.follow, false)

	const offline = resolveFailedDecision(sampleAction('running'), timeout, null)
	assert.equal(offline.action.status, 'pending')
	assert.equal(offline.banner, timeout.message)
	assert.equal(offline.follow, false)

	// Server recorded a real step error: show the server's error on the card.
	const serverErr = resolveFailedDecision(sampleAction('running'), timeout, sampleAction('error', {error: 'Disk full'}))
	assert.equal(serverErr.action.status, 'error')
	assert.equal(serverErr.action.error, 'Disk full')
	assert.equal(serverErr.banner, null)
	assert.equal(serverErr.follow, false)

	// Direct step error from omarchyd marks the card as failed.
	const stepErr = resolveFailedDecision(sampleAction('running'), {isApiError: true, code: 'BAD_GATEWAY', status: 502, message: 'Update failed'}, null)
	assert.equal(stepErr.action.status, 'error')
	assert.equal(stepErr.action.error, 'Update failed')
	assert.equal(stepErr.banner, null)
	assert.equal(stepErr.follow, false)

	// Conflict syncs to the server's status when available.
	const conflict = resolveFailedDecision(sampleAction('running'), {isApiError: true, code: 'CONFLICT', status: 409, message: 'That step was already handled'}, sampleAction('done'))
	assert.equal(conflict.action.status, 'done')
	assert.equal(conflict.banner, null)
})
