/** Two-letter mark. The first code point of each word, so a leading emoji stays one character. */
export function initials(name = ''): string {
	const parts = name.trim().split(/\s+/)
	const glyph = (part: string | undefined) => (part ? ([...part][0] ?? '') : '')
	return (glyph(parts[0]) + glyph(parts[1])).toUpperCase() || '•'
}
