// Which layout Automatic picks, and that it doesn't flip on small changes of size.
import assert from 'node:assert/strict'
import {test} from 'node:test'

import {isPhoneDevice, pickDesktop} from '../web/src/layout.ts'

const pc = {width: 1440, height: 900, pointer: true, phone: false}

test('a big screen with a mouse or trackpad gets the desktop; a phone never does', () => {
	assert.equal(pickDesktop(pc), true)
	assert.equal(pickDesktop({...pc, pointer: false}), false, 'a tablet without a mouse')
	assert.equal(pickDesktop({...pc, phone: true}), false)
	assert.equal(pickDesktop({...pc, height: 500}), false, 'too short')
	assert.equal(pickDesktop({...pc, width: 800}), false, 'narrow')
})

test('between 860 and 1000 px it keeps what it had, so half-screen windows don’t flip it', () => {
	assert.equal(pickDesktop({...pc, width: 950}, true), true)
	assert.equal(pickDesktop({...pc, width: 950}, false), false)
	assert.equal(pickDesktop({...pc, width: 950}), false, 'starting there: the phone layout')
	assert.equal(pickDesktop({...pc, width: 859}, true), false)
	assert.equal(pickDesktop({...pc, width: 1000}, false), true)
})

test('phones are recognised by their browser; desktops and iPads aren’t phones', () => {
	assert.equal(isPhoneDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'), true)
	assert.equal(isPhoneDevice('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36'), true)
	assert.equal(isPhoneDevice('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'), false)
	assert.equal(isPhoneDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15'), false, 'iPadOS reports as a Mac')
	assert.equal(isPhoneDevice('Mozilla/5.0 (Linux; Android 15; Tab) AppleWebKit/537.36 Chrome/131.0 Safari/537.36'), false, 'an Android tablet')
	assert.equal(isPhoneDevice('anything', true), true, 'the browser says it’s a phone')
})
