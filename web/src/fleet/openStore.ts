// Open the App Store aimed at one machine. The dock's App Store is the main one and asks.

export const OPEN_STORE = 'omarchy-open-store'

export type StoreBinding = {id: string; kind: 'server' | 'computer' | 'guest'; name: string}

export function openStore(bound: StoreBinding) {
	window.dispatchEvent(new CustomEvent<StoreBinding>(OPEN_STORE, {detail: bound}))
}
