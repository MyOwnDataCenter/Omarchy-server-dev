import {Icon} from '../icons'
import {haptic} from '../ui'

// The disclosure triangle sits beside Open and Pin. The machine name stays plain text.
export function Disc({open, name, controls, onClick}: {open: boolean; name: string; controls: string; onClick: () => void}) {
	return (
		<button
			type="button"
			className="disc"
			aria-expanded={open}
			aria-controls={controls}
			aria-label={`${open ? 'Hide' : 'Show'} apps and virtual machines on ${name}`}
			onClick={() => (haptic(6), onClick())}
		>
			<Icon name="chevron" size={16} />
		</button>
	)
}
