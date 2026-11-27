// Which layout Automatic picks: the desktop on a big enough screen that has a mouse or trackpad
// anywhere (a touchscreen PC or a touch laptop still counts), never on a phone. Between 860 and
// 1000 px wide it keeps what it had, so snapping a window to half the screen doesn't flip it.
export const LAYOUT_POINTER = '(any-pointer: fine), (any-hover: hover)'
export const BIG = {up: 1000, down: 860, height: 560}

type Env = {width: number; height: number; pointer: boolean; phone: boolean}
export function pickDesktop(env: Env, was?: boolean): boolean {
	if (env.phone || !env.pointer || env.height < BIG.height) return false
	if (env.width >= BIG.up) return true
	if (env.width < BIG.down) return false
	return was ?? false
}

const PHONE_UA = /iPhone|iPod|Android.+Mobile|Mobile.+Firefox|Windows Phone/i
export const isPhoneDevice = (ua: string, mobileHint?: boolean) => mobileHint === true || PHONE_UA.test(ua)

export function detectDesktop(was?: boolean): boolean {
	const nav = navigator as Navigator & {userAgentData?: {mobile?: boolean}}
	return pickDesktop({width: window.innerWidth, height: window.innerHeight, pointer: matchMedia(LAYOUT_POINTER).matches, phone: isPhoneDevice(navigator.userAgent, nav.userAgentData?.mobile)}, was)
}
