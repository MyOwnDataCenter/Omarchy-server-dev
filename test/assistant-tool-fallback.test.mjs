import assert from 'node:assert/strict'
import {mkdtemp, rm} from 'node:fs/promises'
import os from 'node:os'
import {join} from 'node:path'
import {test} from 'node:test'

import {createAssistant} from '../omarchyd/assistant.mjs'
import {forgetTextToolModels, toolProtocolMessages, toolsUnsupported, withToolFallback} from '../omarchyd/assistant/providers.mjs'

const OWNER = {userId: 'owner', role: 'owner'}
const fakeAccounts = () => ({getUser: (id) => (id === 'owner' ? OWNER : null)})
const TOOLS = [{type: 'function', function: {name: 'system_disk', description: 'Disk use', parameters: {type: 'object', properties: {}}}}]
const chatSse = (text) => ({
	ok: true,
	status: 200,
	body: (async function* () {
		yield new TextEncoder().encode(`data: ${JSON.stringify({choices: [{delta: {content: text}}]})}\n\ndata: [DONE]\n\n`)
	})(),
})
const refuse = (message, status = 400) => ({ok: false, status, text: async () => JSON.stringify({error: {message}})})
const collect = async (gen) => {
	const out = []
	for await (const ev of gen) out.push(ev)
	return out
}

test('toolsUnsupported recognises Ollama and OpenRouter refusals, not other errors', () => {
	assert.equal(toolsUnsupported({type: 'error', status: 400, message: 'registry.ollama.ai/library/gemma3:12b does not support tools'}), true)
	assert.equal(toolsUnsupported({type: 'error', status: 404, message: 'No endpoints found that support tool use'}), true)
	assert.equal(toolsUnsupported({type: 'error', status: 401, message: 'does not support tools'}), false)
	assert.equal(toolsUnsupported({type: 'error', status: 400, message: 'context length exceeded'}), false)
})

test('toolProtocolMessages writes the tools into the system prompt and calls and results as text', () => {
	const out = toolProtocolMessages(
		[
			{role: 'system', content: 'sys'},
			{role: 'user', content: 'disk?'},
			{role: 'assistant', content: null, tool_calls: [{id: 'c1', type: 'function', function: {name: 'system_disk', arguments: '{"path":"/"}'}}]},
			{role: 'tool', tool_call_id: 'c1', content: 'free 10'},
			{role: 'user', content: 'thanks'},
		],
		TOOLS,
	)
	assert.equal(out[0].role, 'system')
	assert.match(out[0].content, /^sys\n\n# Tool calling/)
	assert.match(out[0].content, /"name":"system_disk"/)
	assert.deepEqual(out.slice(1), [
		{role: 'user', content: 'disk?'},
		{role: 'assistant', content: '<tool_call>{"name":"system_disk","arguments":{"path":"/"}}</tool_call>'},
		{role: 'user', content: '<tool_response name="system_disk">\nfree 10\n</tool_response>\n\nthanks'},
	])
	assert.equal(out.some((m) => m.role === 'tool' || m.tool_calls), false)
})

test('a model that refuses native tools is asked again with tools as text, and remembered', async () => {
	forgetTextToolModels()
	const bodies = []
	const stream = async function* (opts) {
		bodies.push(opts)
		if (opts.tools.length) yield {type: 'error', status: 400, message: 'gemma3 does not support tools'}
		else yield {type: 'text', text: 'ok'}
	}
	const opts = {baseUrl: 'http://127.0.0.1:11434/v1', model: 'gemma3', messages: [{role: 'user', content: 'hi'}], tools: TOOLS}
	assert.deepEqual(await collect(withToolFallback(stream, opts)), [{type: 'text', text: 'ok'}])
	assert.equal(bodies.length, 2)
	assert.equal(bodies[1].tools.length, 0)
	assert.match(bodies[1].messages[0].content, /<tool_call>/)
	await collect(withToolFallback(stream, opts))
	assert.equal(bodies.length, 3, 'the second turn skips the refused request')
	await collect(withToolFallback(stream, {...opts, model: 'qwen3'}))
	assert.equal(bodies[3].tools.length, 1, 'another model still gets native tools')
})

test('other errors pass through untouched', async () => {
	forgetTextToolModels()
	const stream = async function* () {
		yield {type: 'error', status: 400, message: 'context length exceeded'}
	}
	assert.deepEqual(await collect(withToolFallback(stream, {baseUrl: 'x', model: 'm', messages: [], tools: TOOLS})), [{type: 'error', status: 400, message: 'context length exceeded'}])
})

test('a whole turn: Ollama refuses tools, the text protocol runs the lookup, then the reply streams', async () => {
	forgetTextToolModels()
	const dataDir = await mkdtemp(join(os.tmpdir(), 'atf-'))
	const bodies = []
	const replies = [
		refuse('registry.ollama.ai/library/gemma3:12b does not support tools'),
		chatSse('<tool_call>{"name": "system_getHostname", "arguments": {}}</tool_call>'),
		chatSse('It is called box.'),
	]
	const fetchImpl = async (_url, opts) => {
		bodies.push(JSON.parse(opts.body))
		return replies[bodies.length - 1]
	}
	const runProcedure = async (name) => (name === 'system.getHostname' ? 'box' : null)
	try {
		const asst = createAssistant({dataDir, accounts: fakeAccounts(), now: () => 1, fetchImpl, runProcedure})
		await asst.keys.add(OWNER, {provider: 'openai-compatible', apiKey: '', model: 'gemma3:12b', baseUrl: 'http://127.0.0.1:11434/v1'})
		const events = []
		await asst.runTurn({userId: 'owner', role: 'owner', message: 'what is this machine called?', emit: (e) => events.push(e)})
		assert.equal(bodies.length, 3)
		assert.ok(bodies[0].tools?.length)
		assert.equal(bodies[1].tools, undefined)
		assert.equal(bodies[1].tool_choice, undefined)
		assert.match(bodies[2].messages.at(-1).content, /<tool_response name="system_getHostname">/)
		assert.equal(events.some((e) => e.event === 'error'), false)
		assert.equal(events.filter((e) => e.event === 'text').map((e) => e.data.text).join(''), 'It is called box.')
	} finally {
		await rm(dataDir, {recursive: true, force: true})
	}
})
