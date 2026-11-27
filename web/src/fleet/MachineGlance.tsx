import type {Machine, UserApp} from '../api'
import {Icon} from '../icons'
import {AppIcon, StatusPill, appStatus, haptic, machineStatus} from '../ui'

// Apps and guests shown under a machine. A missing list means that ability was not granted.
export function MachineGlance({
	name,
	apps,
	appsReason,
	vms,
	vmsReason,
	onOpenApp,
	onOpenVm,
	onCreateVm,
	showVms = true,
}: {
	name: string
	apps: UserApp[] | null
	appsReason: string
	vms: Machine[] | null
	vmsReason: string
	onOpenApp?: (app: UserApp) => void
	onOpenVm?: (id: string) => void
	onCreateVm?: () => void
	/** The desktop tree lists guests as its own leaves, so it hides this section. */
	showVms?: boolean
}) {
	return (
		<div className="glance">
			<h3>Apps</h3>
			{apps === null ? (
				<p className="reason">{appsReason}</p>
			) : apps.length === 0 ? (
				<p className="quiet">No apps on {name}.</p>
			) : (
				apps.map((app) => (
					<button key={app.id} type="button" className="run-row" onClick={() => (haptic(6), onOpenApp?.(app))}>
						<AppIcon src={app.icon} name={app.name} size={36} />
						<span style={{flex: 1, minWidth: 0}}>
							<b>{app.name}</b>
							<small>{appStatus(app.state).label}</small>
						</span>
					</button>
				))
			)}
			{showVms && (
				<>
					<h3>Virtual machines</h3>
					{vms === null ? (
						<p className="reason">{vmsReason}</p>
					) : (
						<>
							{vms.length === 0 ? (
								<p className="quiet">No virtual machines on {name}.</p>
							) : (
								vms.map((vm) => (
									<div key={vm.id} className="run-row">
										<span style={{flex: 1, minWidth: 0}}>
											<b>{vm.name}</b>
											<small>Virtual machine</small>
										</span>
										<StatusPill {...machineStatus(vm.state)} />
										<button type="button" className="btn small" onClick={() => (haptic(6), onOpenVm?.(vm.id))}>
											Open
										</button>
									</div>
								))
							)}
							{onCreateVm && (
								<button type="button" className="btn small" onClick={() => (haptic(6), onCreateVm())}>
									<Icon name="plus" size={15} /> Create VM
								</button>
							)}
						</>
					)}
				</>
			)}
		</div>
	)
}
