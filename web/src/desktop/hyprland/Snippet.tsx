import {useState} from 'react'

import {Segmented, useToast} from '../../ui'
import {SNIPPETS, SNIPPET_HELP, type SnippetFormat} from './grab'

// The Hyprland lines that pass keys to this browser, for whichever config format this Omarchy uses.
// Copied by the person and pasted on their own computer; the server never writes them.
export function SnippetBlock({flash = false}: {flash?: boolean}) {
	const toast = useToast()
	const [format, setFormat] = useState<SnippetFormat>('lua')
	const s = SNIPPETS[format]
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(s.text)
			toast(`Copied. Paste it at the end of ${s.file}, then run hyprctl reload.`)
		} catch {
			toast('Select the snippet and copy it')
		}
	}
	return (
		<div className="hypr-snippet-block">
			<Segmented<SnippetFormat>
				label="Config file"
				value={format}
				options={[
					{id: 'lua', label: SNIPPETS.lua.label},
					{id: 'conf', label: SNIPPETS.conf.label},
				]}
				onChange={setFormat}
			/>
			<pre className={`hypr-snippet${flash ? ' flash' : ''}`} tabIndex={0}>
				{s.text}
			</pre>
			<p className="footer-note pz-note">{SNIPPET_HELP}</p>
			<button className="btn primary" onClick={copy}>
				Copy snippet
			</button>
		</div>
	)
}
