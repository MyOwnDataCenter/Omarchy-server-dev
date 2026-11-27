import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {describe, test} from 'node:test'

import {SEQ, applyTerminalModifiers} from '../web/src/terminalKeys.ts'

describe('terminal key modifiers', () => {
	test('#343: applies Ctrl and Alt to arrows, Home, and End and clears only when used', async () => {
		// Ctrl + Left -> CSI 1;5 D and clears Ctrl so the next typed character stays plain.
		const afterCtrlLeft = applyTerminalModifiers(SEQ.left, {ctrl: true, alt: false}, {applyAppCursor: true})
		assert.deepEqual(afterCtrlLeft, {data: '\x1b[1;5D', ctrl: false, alt: false})
		assert.deepEqual(applyTerminalModifiers('c', {ctrl: afterCtrlLeft.ctrl, alt: afterCtrlLeft.alt}), {data: 'c', ctrl: false, alt: false})

		// Alt + Left -> CSI 1;3 D and clears Alt.
		assert.deepEqual(applyTerminalModifiers(SEQ.left, {ctrl: false, alt: true}, {applyAppCursor: true}), {data: '\x1b[1;3D', ctrl: false, alt: false})

		// Ctrl + Alt + Up -> CSI 1;7 A and clears both.
		assert.deepEqual(applyTerminalModifiers(SEQ.up, {ctrl: true, alt: true}, {applyAppCursor: true}), {data: '\x1b[1;7A', ctrl: false, alt: false})

		// Home, End, Right, Down with Ctrl.
		assert.deepEqual(applyTerminalModifiers(SEQ.home, {ctrl: true, alt: false}, {applyAppCursor: true}), {data: '\x1b[1;5H', ctrl: false, alt: false})
		assert.deepEqual(applyTerminalModifiers(SEQ.end, {ctrl: true, alt: false}, {applyAppCursor: true}), {data: '\x1b[1;5F', ctrl: false, alt: false})
		assert.deepEqual(applyTerminalModifiers(SEQ.right, {ctrl: true, alt: false}, {applyAppCursor: true}), {data: '\x1b[1;5C', ctrl: false, alt: false})
		assert.deepEqual(applyTerminalModifiers(SEQ.down, {ctrl: true, alt: false}, {applyAppCursor: true}), {data: '\x1b[1;5B', ctrl: false, alt: false})

		// Modified cursor keys always use CSI even in application cursor keys mode.
		assert.deepEqual(applyTerminalModifiers(SEQ.up, {ctrl: true, alt: false}, {appCursor: true, applyAppCursor: true}), {data: '\x1b[1;5A', ctrl: false, alt: false})
		// Hardware arrow received in appCursor mode still gets modified.
		assert.deepEqual(applyTerminalModifiers('\x1bOD', {ctrl: true, alt: false}), {data: '\x1b[1;5D', ctrl: false, alt: false})

		// Unmodified cursor keys respect appCursor only when applyAppCursor is set.
		assert.deepEqual(applyTerminalModifiers(SEQ.up, {ctrl: false, alt: false}, {appCursor: true, applyAppCursor: true}), {data: '\x1bOA', ctrl: false, alt: false})
		assert.deepEqual(applyTerminalModifiers(SEQ.up, {ctrl: false, alt: false}, {appCursor: true, applyAppCursor: false}), {data: '\x1b[A', ctrl: false, alt: false})

		// Single characters with Ctrl / Alt.
		assert.deepEqual(applyTerminalModifiers('c', {ctrl: true, alt: false}), {data: '\x03', ctrl: false, alt: false})
		assert.deepEqual(applyTerminalModifiers('c', {ctrl: true, alt: true}), {data: '\x1b\x03', ctrl: false, alt: false})
		assert.deepEqual(applyTerminalModifiers('/', {ctrl: true, alt: false}), {data: '\x1f', ctrl: false, alt: false})
		assert.deepEqual(applyTerminalModifiers(' ', {ctrl: true, alt: false}), {data: '\x00', ctrl: false, alt: false})
		assert.deepEqual(applyTerminalModifiers('?', {ctrl: true, alt: false}), {data: '\x7f', ctrl: false, alt: false})

		// Unmappable characters keep Ctrl latched; Alt still prefixes.
		assert.deepEqual(applyTerminalModifiers('|', {ctrl: true, alt: false}), {data: '|', ctrl: true, alt: false})
		assert.deepEqual(applyTerminalModifiers('|', {ctrl: false, alt: true}), {data: '\x1b|', ctrl: false, alt: false})

		// Unrecognized multi-char sequences preserve latched modifiers without clearing them.
		assert.deepEqual(applyTerminalModifiers('\x1b[5~', {ctrl: true, alt: false}), {data: '\x1b[5~', ctrl: true, alt: false})
		assert.deepEqual(applyTerminalModifiers('\x1b[5~', {ctrl: false, alt: true}), {data: '\x1b[5~', ctrl: false, alt: true})

		const src = await readFile(new URL('../web/src/Terminal.tsx', import.meta.url), 'utf8')
		assert.match(src, /applyTerminalModifiers\(/)
	})

	test('Option types characters: macOptionIsMeta is off because the on-screen alt key sends Meta', async () => {
		const src = await readFile(new URL('../web/src/Terminal.tsx', import.meta.url), 'utf8')
		assert.match(src, /macOptionIsMeta:\s*false/)
		assert.doesNotMatch(src, /macOptionIsMeta:\s*true/)
	})
})
