// The assistant's characters. Purely how the assistant looks: none of this reaches the assistant's
// prompts, tools or permissions.
//
// Each character is a set of frames, one per state, in web/public/assistant/<id>/<state>.webp (square,
// 256 px, transparent, cut from the character sheet). To add a character: add its nine frames there
// and one entry below. Movement (floating, bouncing, blinking, talking) is added by AssistantCharacter.
import type {CharacterState} from '../assistantActivity'

export const STATES: CharacterState[] = ['idle', 'hover', 'listening', 'thinking', 'responding', 'working', 'success', 'error', 'sleeping']

export type CharacterDef = {
	id: string
	name: string
	/** One line under the name in the picker. */
	tagline: string
	description: string
	/** The character's glow, for its shadow and selection ring. */
	accent: string
	/** 'fixed': the frames keep their own colours on every theme. */
	theme: 'fixed'
	/** States it has frames for (all nine for the built-in characters). */
	states: CharacterState[]
	/** The frame for a state (falls back to idle). */
	frame: (state: CharacterState) => string
}

const frames = (id: string) => (state: CharacterState) => `/assistant/${id}/${STATES.includes(state) ? state : 'idle'}.webp`
const GREEN = '#a3e635'
const PURPLE = '#a78bfa'

export const CHARACTERS: CharacterDef[] = [
	{
		id: 'oma',
		name: 'Oma',
		tagline: 'The friendly ops assistant',
		description: 'The Omarchy mascot. Your friendly AI sidekick for the homelab.',
		accent: GREEN,
		theme: 'fixed',
		states: STATES,
		frame: frames('oma'),
	},
	{
		id: 'patch',
		name: 'Patch',
		tagline: 'Your systems sidekick',
		description: 'The tech-savvy assistant. Built for fixes, builds, and getting it done.',
		accent: GREEN,
		theme: 'fixed',
		states: STATES,
		frame: frames('patch'),
	},
	{
		id: 'pixel',
		name: 'Pixel',
		tagline: 'The creative builder',
		description: 'The creative one. A digital companion for design, code, and ideas.',
		accent: PURPLE,
		theme: 'fixed',
		states: STATES,
		frame: frames('pixel'),
	},
	{
		id: 'stack',
		name: 'Stack',
		tagline: 'The infrastructure pro',
		description: 'Your infrastructure buddy. Keeps your systems, VMs, and containers in check.',
		accent: GREEN,
		theme: 'fixed',
		states: STATES,
		frame: frames('stack'),
	},
	{
		id: 'pulse',
		name: 'Pulse',
		tagline: 'The health & monitoring buddy',
		description: 'The operations monitor. Always watching, always in sync with your homelab.',
		accent: PURPLE,
		theme: 'fixed',
		states: STATES,
		frame: frames('pulse'),
	},
	{
		id: 'orbit',
		name: 'Orbit',
		tagline: 'Your exploration companion',
		description: 'The explorer. Your go-to for research, automation, and discovery.',
		accent: GREEN,
		theme: 'fixed',
		states: STATES,
		frame: frames('orbit'),
	},
]

export const DEFAULT_CHARACTER = 'oma'
export const characterById = (id: string | null | undefined) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0]
