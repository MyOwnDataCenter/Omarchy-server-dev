// The assistant's character: the frame for what the assistant is doing (from the character sheet),
// brought to life like a flip-book (a blink now and then using the sleeping frame's closed eyes, a
// mouth that moves while it answers) plus gentle CSS motion (floating, a hop, a shake). Still for
// reduced motion, when turned off, or while the tab is in the background.
import {createContext, useContext, useEffect, useRef, useState, type CSSProperties} from 'react'

import {useAssistantAnimationState, type CharacterState} from '../assistantActivity'
import {characterById, CHARACTERS, DEFAULT_CHARACTER, STATES} from './registry'

// ---- the look (saved per account with the other preferences) ---------------------------------
export type AssistantLook = {
	character: string
	name: string
	animate: boolean
	intensity: 'minimal' | 'normal' | 'playful'
	size: 'small' | 'medium' | 'large'
	floating: boolean
	reactions: boolean
	/** Where you put the floating character, as a fraction of the screen (0–1), per layout. */
	position: {phone?: Spot; desktop?: Spot}
}
export type Spot = {x: number; y: number}
export const DEFAULT_LOOK: AssistantLook = {character: DEFAULT_CHARACTER, name: '', animate: true, intensity: 'normal', size: 'medium', floating: true, reactions: true, position: {}}
const cleanSpot = (v: unknown): Spot | undefined => {
	const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
	const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : null)
	const x = n(o?.x)
	const y = n(o?.y)
	return x === null || y === null ? undefined : {x: Math.round(x * 1e4) / 1e4, y: Math.round(y * 1e4) / 1e4}
}
export const NAME_MAX = 24
export const cleanName = (v: unknown) =>
	String(v ?? '')
		.replace(/[\u0000-\u001f\u007f<>]/g, '')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, NAME_MAX)
export function cleanLook(v: unknown): AssistantLook {
	const o = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
	const pick = <T extends string>(x: unknown, ok: readonly T[], d: T): T => (ok.includes(x as T) ? (x as T) : d)
	return {
		character: CHARACTERS.some((c) => c.id === o.character) ? String(o.character) : DEFAULT_LOOK.character,
		name: cleanName(o.name),
		animate: o.animate !== false,
		intensity: pick(o.intensity, ['minimal', 'normal', 'playful'] as const, 'normal'),
		size: pick(o.size, ['small', 'medium', 'large'] as const, 'medium'),
		floating: o.floating !== false,
		reactions: o.reactions !== false,
		position: (() => {
			const p = o.position && typeof o.position === 'object' ? (o.position as Record<string, unknown>) : {}
			const phone = cleanSpot(p.phone)
			const desktop = cleanSpot(p.desktop)
			return {...(phone ? {phone} : {}), ...(desktop ? {desktop} : {})}
		})(),
	}
}
// The name shown for the assistant: yours, or the character's.
export const lookName = (look: AssistantLook) => look.name || characterById(look.character).name

export const AssistantLookContext = createContext<{look: AssistantLook; setLook: (next: AssistantLook) => void}>({look: DEFAULT_LOOK, setLook: () => {}})
export const useAssistantLook = () => useContext(AssistantLookContext)

// Load a character's frames once, so switching state never flickers.
const loaded = new Set<string>()
function preload(id: string) {
	if (loaded.has(id) || typeof Image === 'undefined') return
	loaded.add(id)
	const c = characterById(id)
	for (const s of STATES) new Image().src = c.frame(s)
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

// Which frame to show right now: the state's own, with a blink (idle) or a moving mouth (answering).
function useFrame(state: CharacterState, animate: boolean): CharacterState {
	const [alt, setAlt] = useState(false)
	useEffect(() => {
		setAlt(false)
		if (!animate || reducedMotion()) return
		const hidden = () => document.visibilityState === 'hidden'
		if (state === 'responding') {
			const t = window.setInterval(() => !hidden() && setAlt((a) => !a), 230)
			return () => window.clearInterval(t)
		}
		if (state === 'idle' || state === 'listening') {
			let t = 0
			const next = () => {
				t = window.setTimeout(() => {
					if (!hidden()) setAlt(true)
					t = window.setTimeout(() => (setAlt(false), next()), 150)
				}, 3500 + Math.random() * 4000)
			}
			next()
			return () => window.clearTimeout(t)
		}
	}, [state, animate])
	if (!alt) return state
	return state === 'responding' ? 'idle' : 'sleeping' // mouth closed / eyes closed
}

// Frames cross-fade instead of snapping: the new one fades in over the old, which then goes.
function useLayers(src: string) {
	const [layers, setLayers] = useState([{src, key: 0, out: false}])
	const n = useRef(0)
	useEffect(() => {
		setLayers((ls) => (ls[ls.length - 1]?.src === src ? ls : [...ls.filter((l) => !l.out).map((l) => ({...l, out: true})), {src, key: ++n.current, out: false}]))
		const t = window.setTimeout(() => setLayers((ls) => ls.filter((l) => !l.out)), 260)
		return () => window.clearTimeout(t)
	}, [src])
	return layers
}

export function AssistantCharacter({
	id,
	state = 'idle',
	size = 56,
	animate = true,
	intensity = 'normal',
	label,
	shadow = false,
	className = '',
	style,
}: {
	id?: string
	state?: CharacterState
	size?: number
	animate?: boolean
	intensity?: AssistantLook['intensity']
	/** Spoken name; leave out where the character is decoration next to a visible label. */
	label?: string
	/** A soft shadow under it (the floating character). */
	shadow?: boolean
	className?: string
	style?: CSSProperties
}) {
	const c = characterById(id)
	useEffect(() => preload(c.id), [c.id])
	const frame = useFrame(state, animate)
	const layers = useLayers(c.frame(frame))
	return (
		<span
			className={`ac ac--${c.id} is-${state} ac-${intensity}${animate ? '' : ' still'}${shadow ? ' has-shadow' : ''} ${className}`}
			style={{'--ac-1': c.accent, width: size, height: size, ...style} as CSSProperties}
			role={label ? 'img' : undefined}
			aria-label={label}
			aria-hidden={label ? undefined : true}
		>
			{shadow && <span className="ac-shadow" />}
			<span className="ac-body">
				{layers.map((l) => (
					<img key={l.key} className={`ac-img${l.out ? ' out' : ''}`} src={l.src} alt="" width={size} height={size} draggable={false} decoding="async" />
				))}
			</span>
		</span>
	)
}

// The character where an icon was (Home tile, desktop icon), reacting like the floating one.
export function AssistantAvatar({size = 56, live = true}: {size?: number; live?: boolean}) {
	const {look} = useAssistantLook()
	const state = useAssistantAnimationState({reactions: look.reactions && live})
	return <AssistantCharacter id={look.character} state={live ? state : 'idle'} size={size} animate={look.animate && live} intensity={look.intensity} />
}
