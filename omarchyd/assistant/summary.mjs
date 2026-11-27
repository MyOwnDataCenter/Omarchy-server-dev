// Long chats: instead of silently dropping the oldest messages, the model writes a summary of them
// once the chat grows past a budget, and later turns send that summary plus the recent messages.
// The saved chat keeps every message; only what goes to the provider is shorter. The summary is
// redone, building on the last one, each time the unsummarized part grows past the budget again.
//
// Sizes are rough: about four characters a token, which is close enough to decide when to summarize.

// Summarize when the unsummarized part is over this many tokens, or this many messages.
export const SUMMARY_TRIGGER_TOKENS = 24_000
export const SUMMARY_TRIGGER_MESSAGES = 40
// Keep at least this much of the most recent chat word for word.
export const KEEP_TOKENS = 6_000
// ...or this many messages, whichever is reached first.
export const KEEP_MESSAGES = 20
// Longest transcript sent to be summarized, and the most kept of any one tool result in it.
const TRANSCRIPT_CHARS = 120_000
const TOOL_RESULT_CHARS = 1_500
const SUMMARY_CHARS = 8_000

export const SUMMARY_PROMPT = [
	'You keep the running notes for a chat between a person and the My Own Data Center assistant, which looks things up and proposes changes on their server.',
	'Write a summary of the conversation below that the assistant can rely on later instead of the full text.',
	'Keep: what the person wants and any preferences they stated; facts learned from lookups (names, ids, sizes, versions) that may matter again; what was changed, approved, rejected or failed; anything still open.',
	'Drop greetings, repetition and raw tool output that no longer matters.',
	'Write plain prose or short bullet points, under 400 words. Reply with the summary only.',
].join(' ')

const charsOf = (m) => String(m?.content ?? '').length + (Array.isArray(m?.toolCalls) ? m.toolCalls.reduce((n, t) => n + String(t?.name ?? '').length + String(t?.arguments ?? '').length, 0) : 0)
export const estimateTokens = (messages) => Math.ceil((messages ?? []).reduce((n, m) => n + charsOf(m), 0) / 4)

export const summaryOf = (row) => {
	const s = row?.summary
	if (!s || typeof s.text !== 'string' || !s.text.trim()) return null
	const upTo = Number.isInteger(s.upTo) && s.upTo > 0 && s.upTo <= (row.messages?.length ?? 0) ? s.upTo : 0
	return upTo ? {text: s.text, upTo} : null
}

// The messages that still go to the provider word for word.
export const unsummarized = (row) => (row?.messages ?? []).slice(summaryOf(row)?.upTo ?? 0)

export function needsSummary(row) {
	const rest = unsummarized(row).filter((m) => m?.role !== 'action')
	return rest.length > SUMMARY_TRIGGER_MESSAGES || estimateTokens(rest) > SUMMARY_TRIGGER_TOKENS
}

// Where the summary can end: at the start of a person's message, so a tool call and its result are
// never split, keeping at least KEEP_TOKENS of the newest chat and the latest message. -1 if nowhere.
export function pickCut(messages, from = 0, keepTokens = KEEP_TOKENS) {
	const list = messages ?? []
	let lastUser = -1
	for (let i = list.length - 1; i >= from; i--) {
		if (list[i]?.role === 'user') {
			lastUser = i
			break
		}
	}
	if (lastUser <= from) return -1
	let kept = 0
	let i = list.length
	while (i > from && kept < keepTokens && list.length - i < KEEP_MESSAGES) kept += Math.ceil(charsOf(list[--i]) / 4)
	// Walk back to the nearest person's message at or before that point.
	while (i > from && list[i]?.role !== 'user') i--
	const cut = Math.min(i, lastUser)
	return cut > from && list[cut]?.role === 'user' ? cut : -1
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s)

// The older part of the chat as plain text, for the model to summarize.
export function transcript(messages, actions) {
	const actionById = new Map((actions ?? []).filter((a) => a?.id).map((a) => [a.id, a]))
	const lines = []
	for (const m of messages ?? []) {
		if (m?.role === 'user') lines.push(`Person: ${m.content ?? ''}`)
		else if (m?.role === 'assistant') {
			if (m.content) lines.push(`Assistant: ${m.content}`)
			for (const t of m.toolCalls ?? []) lines.push(`Assistant called ${t.name} ${t.arguments || '{}'}`)
		} else if (m?.role === 'tool') lines.push(`Result of ${m.name ?? 'the tool'}: ${clip(String(m.content ?? ''), TOOL_RESULT_CHARS)}`)
		else if (m?.role === 'action') {
			const a = actionById.get(m.actionId)
			if (a) lines.push(`Proposed change: ${a.title}${a.detail ? ` (${a.detail})` : ''}, ${a.status === 'done' ? 'approved and done' : a.status}`)
		}
	}
	let text = lines.join('\n\n')
	// Keep the newest part when it is still too long: older detail is the least likely to matter.
	if (text.length > TRANSCRIPT_CHARS) text = `…\n${text.slice(-TRANSCRIPT_CHARS)}`
	return text
}

// Ask the model for the summary. Resolves to the text, or null when it could not be written.
export async function writeSummary({stream, previous, messages, actions, signal}) {
	const body = [previous ? `Summary so far:\n${previous}\n\nWhat happened after that:` : 'Conversation:', transcript(messages, actions)].join('\n\n')
	let text = ''
	for await (const ev of stream({messages: [{role: 'system', content: SUMMARY_PROMPT}, {role: 'user', content: body}], tools: [], signal})) {
		if (signal?.aborted) return null
		if (ev.type === 'text') text += ev.text
		else if (ev.type === 'error') return null
	}
	text = text.trim()
	return text ? clip(text, SUMMARY_CHARS) : null
}

export const summaryNote = (text) => `Summary of the earlier part of this chat (the messages before it are no longer shown to you):\n${text}`
