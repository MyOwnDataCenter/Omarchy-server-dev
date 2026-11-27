import {Component, Fragment, type ReactNode} from 'react'

import {Icon} from './icons'
import {caughtScreenError, retryScreen, screenErrorView} from './screenError'

type BoundaryState = {error: unknown; retry: number}

export class ScreenErrorBoundary extends Component<{children: ReactNode}, BoundaryState> {
	state: BoundaryState = {error: null, retry: 0}

	static getDerivedStateFromError(error: unknown): {error: unknown} {
		return caughtScreenError(error)
	}

	render() {
		const view = screenErrorView(this.state)
		if (view) {
			return (
				<div className="error" role="alert">
					<Icon name="alert" size={18} />
					<span>
						{view.message}{' '}
						<button type="button" onClick={() => this.setState((s) => retryScreen(s))}>
							{view.retryLabel}
						</button>
					</span>
				</div>
			)
		}
		return <Fragment key={this.state.retry}>{this.props.children}</Fragment>
	}
}
