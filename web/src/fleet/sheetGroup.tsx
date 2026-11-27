import type {CSSProperties, ReactNode} from 'react'

/** Section heading and glass group used on every machine page. */
export function SheetGroup({title, children}: {title: string; children: ReactNode}) {
	return (
		<>
			<div className="section-head" style={{margin: '20px 4px 8px'}}>
				<h2 style={{fontSize: 16}}>{title}</h2>
			</div>
			<div className="glass group" style={{'--inset': '62px'} as CSSProperties}>
				{children}
			</div>
		</>
	)
}
