import assert from 'node:assert/strict'
import {describe, test} from 'node:test'

import {createReplayHistory} from '../omarchyd/terminal.mjs'

describe('terminal replay history', () => {
	test('#573: trims on safe escape and UTF-8 boundaries across all cut offsets', () => {
		const keep = 512
		const frame = Buffer.from('\x1b[12;40H\x1b[1;32m\xe2\x82\xac\x1b[0m', 'binary')
		const base = Buffer.concat(Array.from({length: 45}, () => frame))

		for (let pad = 0; pad <= 40; pad++) {
			const h = createReplayHistory(keep)
			h.push(base)
			if (pad > 0) h.push(Buffer.alloc(pad, 0x41)) // 'A' padding to shift cut through every offset
			const snap = h.snapshot()
			assert.ok(snap.length > 0, `pad=${pad}: snapshot should be non-empty`)
			assert.notEqual(snap[0] & 0xc0, 0x80, `pad=${pad}: must not start on a UTF-8 continuation byte`)
			const text = snap.toString('utf8')
			assert.equal(text.includes('\uFFFD'), false, `pad=${pad}: must not contain replacement char`)
			assert.match(text, /^(?:\x1b\[|€)/, `pad=${pad}: starts cleanly at CSI or euro sign, got ${JSON.stringify(text.slice(0, 20))}`)
		}
	})

	test('#573: trims pure multi-byte UTF-8 without newlines or escapes cleanly', () => {
		const keep = 200
		for (let leadPad = 0; leadPad < 3; leadPad++) {
			const h = createReplayHistory(keep)
			h.push(Buffer.alloc(leadPad, 0x78)) // 'x'
			h.push(Buffer.from('€'.repeat(120), 'utf8'))
			const snap = h.snapshot()
			assert.notEqual(snap[0] & 0xc0, 0x80)
			const text = snap.toString('utf8')
			assert.equal(text.includes('\uFFFD'), false)
			assert.match(text, /^€+$/)
		}
	})

	test('#573: aligns plain newline-delimited text to a line start', () => {
		const keep = 200
		const h = createReplayHistory(keep)
		const lines = Array.from({length: 40}, (_, i) => `line-${String(i).padStart(2, '0')}-abcdef`).join('\n') + '\n'
		h.push(Buffer.from(lines, 'utf8'))
		const text = h.snapshot().toString('utf8')
		assert.match(text, /^line-\d{2}-abcdef\n/)
	})

	test('#573: restores alternate screen and private modes dropped during trim', () => {
		const keep = 512
		const h = createReplayHistory(keep)
		h.push(Buffer.from('\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?25l'))
		const frame = Buffer.from('\x1b[1;1Hredraw-frame-0123456789')
		for (let i = 0; i < 40; i++) h.push(frame)
		const text = h.snapshot().toString('utf8')
		assert.equal(text.startsWith('\x1b[?1049h'), true)
		const bodyStart = text.indexOf('\x1b[1;1H')
		assert.ok(bodyStart > 0)
		const prefix = text.slice(0, bodyStart)
		assert.equal(prefix.includes('\x1b[?1049h'), true)
		assert.equal(prefix.includes('\x1b[?1h'), true)
		assert.equal(prefix.includes('\x1b[?2004h'), true)
		assert.equal(prefix.includes('\x1b[?25l'), true)
	})

	test('#573: restores combined private mode sequences', () => {
		const keep = 512
		const h = createReplayHistory(keep)
		h.push(Buffer.from('\x1b[?1049;1;2004h'))
		h.push(Buffer.from('X'.repeat(900)))
		const text = h.snapshot().toString('utf8')
		assert.equal(text.includes('\x1b[?1049h'), true)
		assert.equal(text.includes('\x1b[?1h'), true)
		assert.equal(text.includes('\x1b[?2004h'), true)
	})

	test('#573: omits modes that were reset before the trimmed section', () => {
		const keep = 512
		const h = createReplayHistory(keep)
		h.push(Buffer.from('\x1b[?1049h\x1b[?25l'))
		h.push(Buffer.from('A'.repeat(200)))
		h.push(Buffer.from('\x1b[?1049l\x1b[?25h'))
		h.push(Buffer.from('B'.repeat(900)))
		const text = h.snapshot().toString('utf8')
		assert.equal(text.includes('\x1b[?1049h'), false)
		assert.equal(text.includes('\x1b[?25l'), false)
	})

	test('#573: keeps alternate screen ahead of replay when exited after the trim point', () => {
		const keep = 512
		const h = createReplayHistory(keep)
		h.push(Buffer.from('\x1b[?1049h'))
		h.push(Buffer.from('R'.repeat(900))) // triggers trim while alt screen is active
		h.push(Buffer.from('\x1b[?1049lprompt$ '))
		const text = h.snapshot().toString('utf8')
		assert.equal(text.startsWith('\x1b[?1049h'), true)
		assert.equal(text.endsWith('\x1b[?1049lprompt$ '), true)
	})

	test('#573: preserves modes across multiple successive trims', () => {
		const keep = 256
		const h = createReplayHistory(keep)
		h.push(Buffer.from('\x1b[?1049h\x1b[?2004h'))
		for (let i = 0; i < 4; i++) h.push(Buffer.from('Z'.repeat(300)))
		const text = h.snapshot().toString('utf8')
		assert.equal(text.includes('\x1b[?1049h'), true)
		assert.equal(text.includes('\x1b[?2004h'), true)
	})

	test('#573: clears tracked modes on hard reset (ESC c) and soft reset (CSI ! p)', () => {
		const keep = 256
		const hHard = createReplayHistory(keep)
		hHard.push(Buffer.from('\x1b[?1049h\x1b[?1h\x1bc'))
		hHard.push(Buffer.from('M'.repeat(500)))
		const hardText = hHard.snapshot().toString('utf8')
		assert.equal(hardText.includes('\x1b[?1049h'), false)
		assert.equal(hardText.includes('\x1b[?1h'), false)

		const hSoft = createReplayHistory(keep)
		hSoft.push(Buffer.from('\x1b[?1049h\x1b[?2004h\x1b[!p'))
		hSoft.push(Buffer.from('N'.repeat(500)))
		const softText = hSoft.snapshot().toString('utf8')
		assert.equal(softText.includes('\x1b[?1049h'), false)
		assert.equal(softText.includes('\x1b[?2004h'), false)
	})

	test('#573: skips past OSC sequences straddling the cut boundary (BEL and ST)', () => {
		const keep = 200
		for (const term of ['\x07', '\x1b\\']) {
			const h = createReplayHistory(keep)
			h.push(Buffer.from('A'.repeat(190)))
			h.push(Buffer.from(`\x1b]0;secret-title${term}`))
			h.push(Buffer.from('B'.repeat(190)))
			const text = h.snapshot().toString('utf8')
			assert.equal(text.includes('secret-title'), false, 'OSC payload must not leak at start of replay')
			assert.equal(text, 'B'.repeat(190))
		}
	})

	test('#573: handles mode sequence split directly across the raw cut boundary', () => {
		const keep = 200
		const h = createReplayHistory(keep)
		h.push(Buffer.from('A'.repeat(196)))
		h.push(Buffer.from('\x1b[?1049h')) // spans bytes 196..203 while target cut is 200
		h.push(Buffer.from('B'.repeat(196)))
		const text = h.snapshot().toString('utf8')
		assert.equal(text, '\x1b[?1049h' + 'B'.repeat(196))
	})

	test('#573: returns untrimmed history verbatim without duplicating mode prefixes', () => {
		const keep = 512
		const h = createReplayHistory(keep)
		const raw = Buffer.from('\x1b[?1049hhello\n')
		h.push(raw)
		assert.deepEqual(h.snapshot(), raw)
	})

	test('#573: tracks mutually exclusive mouse tracking modes cleanly', () => {
		const keep = 256
		const h = createReplayHistory(keep)
		h.push(Buffer.from('\x1b[?1002h\x1b[?1003h\x1b[?1006h'))
		h.push(Buffer.from('M'.repeat(500)))
		const text = h.snapshot().toString('utf8')
		assert.equal(text.includes('\x1b[?1002h'), false)
		assert.equal(text.includes('\x1b[?1003h'), true)
		assert.equal(text.includes('\x1b[?1006h'), true)
	})
})
