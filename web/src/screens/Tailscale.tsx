// This server's Tailscale mesh. It lives on the server machine's network section.
import {useEffect, useState, type CSSProperties, type FormEvent} from 'react'
import {useQuery, useQueryClient} from '@tanstack/react-query'

import {mutate, query} from '../api'
import {bytes} from '../formatBytes'
import {Icon} from '../icons'
import {Field, Group, Row, Sheet, SheetHeader, Switch, useConfirm, useToast} from '../ui'

type TailscalePeer = {
	id: string
	hostName: string
	dnsName: string
	os: string
	ips: string[]
	online: boolean
	active: boolean
	direct: boolean
	curAddr: string
	relay: string
	rxBytes: number
	txBytes: number
	lastSeen: string | null
	lastHandshake: string | null
	exitNode: boolean
	exitNodeOption: boolean
	tags: string[]
}

type TailscaleStatus = {
	available: boolean
	operator: boolean
	version: string
	backendState: string
	authUrl: string
	tailnet: string
	magicDnsSuffix: string
	health: string[]
	error?: string
	self: {
		id: string
		hostName: string
		dnsName: string
		os: string
		ips: string[]
		relay: string
		online: boolean
		exitNode: boolean
		advertisingExitNode: boolean
		subnetRoutes: string[]
	} | null
	prefs: {
		wantRunning: boolean
		controlUrl: string
		acceptDns: boolean
		acceptRoutes: boolean
		runSsh: boolean
		shieldsUp: boolean
		exitNodeId: string
		exitNodeAllowLan: boolean
		advertiseExitNode: boolean
		subnetRoutes: string[]
	} | null
	peers: TailscalePeer[]
	summary: {totalPeers: number; onlinePeers: number; directPeers: number; exitNodeOptions: number}
}

type TailscalePingResult = {
	ip: string
	peer: string
	latencyMs: number | null
	direct: boolean
	endpoint: string
	derpRegionCode: string
	error: string
}

function useStatus() {
	return useQuery({
		queryKey: ['tailscale.status'],
		queryFn: () => query<TailscaleStatus>('tailscale.status'),
		retry: false,
		refetchInterval: 10_000,
	})
}

export function TailscaleSheet({onClose}: {onClose: () => void}) {
	const toast = useToast()
	const confirm = useConfirm()
	const qc = useQueryClient()
	const ts = useStatus()
	const [busy, setBusy] = useState(false)
	const [routesInput, setRoutesInput] = useState('')
	const [controlUrlInput, setControlUrlInput] = useState('')
	const [pinging, setPinging] = useState<string | null>(null)
	const [pings, setPings] = useState<Record<string, TailscalePingResult>>({})
	const [loginBusy, setLoginBusy] = useState(false)
	const [loginUrl, setLoginUrl] = useState('')

	const prefs = ts.data?.prefs
	const routeKey = prefs?.subnetRoutes.join(',') ?? ''
	const controlKey = prefs?.controlUrl ?? ''
	useEffect(() => {
		setRoutesInput(routeKey ? routeKey.split(',').join(', ') : '')
		setControlUrlInput(controlKey)
	}, [routeKey, controlKey])

	const patchPrefs = async (patch: Record<string, unknown>, done: string) => {
		setBusy(true)
		try {
			await mutate('tailscale.setPrefs', patch)
			toast(done)
			await qc.invalidateQueries({queryKey: ['tailscale.status']})
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setBusy(false)
		}
	}

	const copyText = async (text: string, label: string) => {
		try {
			await navigator.clipboard.writeText(text)
			toast(`${label} copied`)
		} catch {
			toast(`Couldn’t copy ${label.toLowerCase()}`, true)
		}
	}

	const startLogin = async () => {
		setLoginBusy(true)
		try {
			const res = await mutate<{authUrl: string; backendState: string}>('tailscale.login')
			if (res.authUrl) {
				setLoginUrl(res.authUrl)
				window.open(res.authUrl, '_blank', 'noopener,noreferrer')
				toast('Finish signing in to Tailscale in the opened tab')
			} else if (res.backendState === 'Running') {
				toast('Tailscale is already connected')
			} else {
				toast('Sign-in started. Check again in a moment.')
			}
			await qc.invalidateQueries({queryKey: ['tailscale.status']})
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setLoginBusy(false)
		}
	}

	const signOut = async () => {
		const ok = await confirm({
			title: 'Sign out of Tailscale?',
			body: 'This server will leave the tailnet. It will not be reachable over Tailscale until you sign in again.',
			confirm: 'Sign out',
			danger: true,
		})
		if (!ok) return
		setBusy(true)
		try {
			await mutate('tailscale.logout')
			toast('Signed out of Tailscale')
			await qc.invalidateQueries({queryKey: ['tailscale.status']})
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setBusy(false)
		}
	}

	const pingPeer = async (peer: TailscalePeer) => {
		const ip = peer.ips.find((x) => x.includes('.')) ?? peer.ips[0]
		if (!ip) return
		setPinging(peer.id)
		try {
			const res = await mutate<TailscalePingResult>('tailscale.ping', {ip})
			setPings((prev) => ({...prev, [peer.id]: res}))
		} catch (e) {
			toast((e as Error).message, true)
		} finally {
			setPinging(null)
		}
	}

	const saveRoutes = (e: FormEvent) => {
		e.preventDefault()
		const list = routesInput
			.split(/[,\n\s]+/)
			.map((s) => s.trim())
			.filter(Boolean)
		void patchPrefs({subnetRoutes: list}, list.length ? 'Subnet routes updated' : 'Subnet routes cleared')
	}

	const saveControlUrl = async (e: FormEvent) => {
		e.preventDefault()
		const next = controlUrlInput.trim()
		if (next !== (prefs?.controlUrl ?? '')) {
			const ok = await confirm({
				title: next ? 'Switch Tailscale control server?' : 'Use Tailscale’s control server?',
				body: next
					? `Point Tailscale at ${next}. You may need to sign in again.`
					: 'Clears the custom control URL and uses Tailscale’s own control server.',
				confirm: 'Save URL',
			})
			if (!ok) return
		}
		await patchPrefs({controlUrl: next}, next ? 'Control server URL saved' : 'Tailscale control server restored')
	}

	const d = ts.data
	const canEdit = Boolean(d?.available && d.operator && d.prefs)
	const exitOptions = (d?.peers ?? []).filter((p) => p.exitNodeOption)
	const activeAuthUrl = loginUrl || d?.authUrl || ''
	const onTailscaleHost = Boolean(
		d?.self &&
			(d.self.ips.includes(location.hostname) ||
				(d.self.dnsName && location.hostname.toLowerCase() === d.self.dnsName.toLowerCase()) ||
				(d.magicDnsSuffix && location.hostname.toLowerCase().endsWith(`.${d.magicDnsSuffix.toLowerCase()}`))),
	)

	const toggleRunning = async (on: boolean) => {
		if (!on) {
			const ok = await confirm({
				title: 'Disconnect Tailscale?',
				body: onTailscaleHost
					? 'You appear to be viewing this server over Tailscale. Disconnecting will cut off this session.'
					: 'This server will drop off the tailnet until you connect Tailscale again.',
				confirm: 'Disconnect',
				danger: true,
			})
			if (!ok) return
		}
		await patchPrefs({wantRunning: on}, on ? 'Tailscale connected' : 'Tailscale disconnected')
	}

	const toggleShieldsUp = async (on: boolean) => {
		if (on) {
			const ok = await confirm({
				title: 'Enable Shields up?',
				body: onTailscaleHost
					? 'You appear to be connected over Tailscale. Shields up blocks incoming tailnet connections and will lock out this session.'
					: 'Shields up blocks incoming connections from other devices on the tailnet.',
				confirm: 'Enable Shields up',
				danger: true,
			})
			if (!ok) return
		}
		await patchPrefs({shieldsUp: on}, on ? 'Shields up enabled' : 'Shields up disabled')
	}

	const selectExitNode = async (nextId: string) => {
		if (nextId) {
			const peer = exitOptions.find((p) => p.id === nextId)
			const ok = await confirm({
				title: `Route traffic through ${peer?.hostName || peer?.dnsName || 'this exit node'}?`,
				body: 'Outbound traffic from this server will go through that exit node. Local network access stays on.',
				confirm: 'Use exit node',
			})
			if (!ok) return
			await patchPrefs({exitNodeId: nextId, exitNodeAllowLan: true}, 'Exit node updated')
		} else {
			await patchPrefs({exitNodeId: ''}, 'Exit node cleared')
		}
	}

	return (
		<Sheet open onClose={onClose} label="Tailscale" tall>
			<SheetHeader title="Tailscale" subtitle={d?.tailnet ? `${d.tailnet}${d.version ? ` · v${d.version}` : ''}` : 'Private network for this server'} onClose={onClose} />

			{ts.isLoading && (
				<div className="row static">
					<span className="spinner" />
				</div>
			)}
			{ts.isError && (
				<Group title="Status">
					<Row icon="alert" color="var(--orange, #f59e0b)" label="Couldn’t read Tailscale" sub={(ts.error as Error).message} />
				</Group>
			)}

			{d && !d.available && (
				<Group title="Status">
					<Row icon="alert" color="var(--orange, #f59e0b)" label="Tailscale is not running" sub={d.error || 'Start Tailscale on this server to manage it here.'} />
				</Group>
			)}

			{d?.available && (
				<>
					<Group title="Connection" footer={!d.operator ? 'This view is read-only until this server is Tailscale’s operator.' : undefined}>
						<Row
							icon={d.backendState === 'Running' ? 'check' : 'alert'}
							color={d.backendState === 'Running' ? 'var(--green)' : 'var(--orange, #f59e0b)'}
							label={d.backendState === 'Running' ? 'Connected' : d.backendState === 'NeedsLogin' ? 'Sign in required' : d.backendState}
							sub={d.self?.relay ? `Home relay: ${d.self.relay.toUpperCase()}` : undefined}
							trailing={canEdit && d.prefs ? <Switch on={d.prefs.wantRunning} disabled={busy} label="Connect Tailscale" onChange={toggleRunning} /> : undefined}
						/>
						{d.self?.dnsName && (
							<Row
								icon="networking"
								color="var(--blue)"
								label="Name"
								sub={d.self.dnsName}
								trailing={
									<button type="button" className="btn small" onClick={() => copyText(d.self!.dnsName, 'Name')}>
										Copy
									</button>
								}
							/>
						)}
						{(d.self?.ips.length ?? 0) > 0 && (
							<Row
								icon="network"
								color="var(--teal)"
								label="Addresses"
								sub={d.self!.ips.join(' · ')}
								trailing={
									<button type="button" className="btn small" onClick={() => copyText(d.self!.ips[0], 'Address')}>
										Copy
									</button>
								}
							/>
						)}
						{canEdit && (d.backendState === 'NeedsLogin' || d.backendState === 'NoState' || activeAuthUrl) && (
							<div className="row static" style={{gap: 8, flexWrap: 'wrap'}}>
								<button type="button" className="btn primary small" disabled={loginBusy} onClick={startLogin}>
									{loginBusy ? 'Starting…' : 'Sign in to Tailscale'}
								</button>
								{activeAuthUrl && (
									<a className="btn small" href={activeAuthUrl} target="_blank" rel="noopener noreferrer">
										Open login link
									</a>
								)}
							</div>
						)}
						{canEdit && d.backendState === 'Running' && <Row icon="signout" color="var(--red)" label="Sign out of tailnet" onClick={signOut} />}
					</Group>

					{d.health.length > 0 && (
						<Group title="Health">
							{d.health.map((w, i) => (
								<Row key={i} icon="alert" color="var(--orange, #f59e0b)" label="Warning" sub={w} />
							))}
						</Group>
					)}

					{d.prefs && (
						<Group title="Routing" footer="An exit node or a subnet route still needs approval in the Tailscale admin console.">
							<Row
								icon="networking"
								color="var(--purple, #8b5cf6)"
								label="Advertise as exit node"
								sub="Other devices can send their internet traffic through this server"
								trailing={<Switch on={d.prefs.advertiseExitNode} disabled={!canEdit || busy} label="Advertise as exit node" onChange={(on) => patchPrefs({advertiseExitNode: on}, on ? 'Advertising as an exit node' : 'Stopped advertising an exit node')} />}
							/>
							<div className="row static" style={{justifyContent: 'space-between', gap: 12}}>
								<span className="main">
									<b style={{fontWeight: 550}}>Use an exit node</b>
									<span>{exitOptions.length ? 'Send this server’s outbound traffic through a peer' : d.prefs.exitNodeId ? 'The selected exit node is no longer advertising' : 'No peer is advertising an exit node'}</span>
								</span>
								<select aria-label="Use an exit node" disabled={!canEdit || busy || (exitOptions.length === 0 && !d.prefs.exitNodeId)} value={d.prefs.exitNodeId} onChange={(e) => selectExitNode(e.target.value)} style={{maxWidth: 190}}>
									<option value="">None</option>
									{d.prefs.exitNodeId && !exitOptions.some((p) => p.id === d.prefs!.exitNodeId) && <option value={d.prefs.exitNodeId}>Current exit node</option>}
									{exitOptions.map((p) => (
										<option key={p.id} value={p.id}>
											{p.hostName || p.dnsName}
										</option>
									))}
								</select>
							</div>
							{d.prefs.exitNodeId && (
								<Row
									icon="network"
									color="var(--teal)"
									label="Allow local network access"
									sub="Keep devices on this network reachable while an exit node is in use"
									trailing={<Switch on={d.prefs.exitNodeAllowLan} disabled={!canEdit || busy} label="Allow local network access" onChange={(on) => patchPrefs({exitNodeAllowLan: on}, on ? 'Local network access enabled' : 'Local network access disabled')} />}
								/>
							)}
							<Row icon="networking" color="var(--blue)" label="Accept MagicDNS" trailing={<Switch on={d.prefs.acceptDns} disabled={!canEdit || busy} label="Accept MagicDNS" onChange={(on) => patchPrefs({acceptDns: on}, on ? 'MagicDNS enabled' : 'MagicDNS disabled')} />} />
							<Row icon="link" color="var(--blue)" label="Accept subnet routes" trailing={<Switch on={d.prefs.acceptRoutes} disabled={!canEdit || busy} label="Accept subnet routes" onChange={(on) => patchPrefs({acceptRoutes: on}, on ? 'Accepting subnet routes' : 'Stopped accepting subnet routes')} />} />
							<Row
								icon="terminal"
								color="var(--green)"
								label="Tailscale SSH"
								sub="Allow SSH that the tailnet authenticates"
								trailing={<Switch on={d.prefs.runSsh} disabled={!canEdit || busy} label="Tailscale SSH" onChange={(on) => patchPrefs({runSsh: on}, on ? 'Tailscale SSH enabled' : 'Tailscale SSH disabled')} />}
							/>
							<Row icon="shield" color="var(--red)" label="Shields up" sub="Block incoming connections from the tailnet" trailing={<Switch on={d.prefs.shieldsUp} disabled={!canEdit || busy} label="Shields up" onChange={toggleShieldsUp} />} />
							<form onSubmit={saveRoutes} style={{padding: '10px 14px'}}>
								<Field id="ts-routes" label="Advertised subnet routes" placeholder="192.168.1.0/24, 10.0.1.0/24" value={routesInput} onChange={(e) => setRoutesInput(e.target.value)} disabled={!canEdit} autoCapitalize="off" autoCorrect="off" />
								{canEdit && (
									<button className="btn small" disabled={busy} style={{marginTop: 6}}>
										Save subnet routes
									</button>
								)}
							</form>
							<form onSubmit={saveControlUrl} style={{padding: '6px 14px 12px'}}>
								<Field id="ts-control" label="Control server URL" type="url" placeholder="Leave blank for Tailscale" value={controlUrlInput} onChange={(e) => setControlUrlInput(e.target.value)} disabled={!canEdit} autoCapitalize="off" autoCorrect="off" />
								{canEdit && (
									<button className="btn small" disabled={busy} style={{marginTop: 6}}>
										Save control URL
									</button>
								)}
							</form>
						</Group>
					)}

					<Group title={`Peers (${d.summary.onlinePeers} online)`} footer="Ping measures a direct path against the relay.">
						{d.peers.map((p) => {
							const ip = p.ips.find((x) => x.includes('.')) ?? p.ips[0] ?? ''
							const pingRes = pings[p.id]
							const pathLabel = p.online ? (p.direct ? 'Direct' : p.relay ? `Relay (${p.relay.toUpperCase()})` : 'Online') : 'Offline'
							const traffic = p.rxBytes || p.txBytes ? ` · ↓${bytes(p.rxBytes, 0)} ↑${bytes(p.txBytes, 0)}` : ''
							const exitBadge = p.exitNode ? ' · Exit node in use' : p.exitNodeOption ? ' · Can be an exit node' : ''
							const pingLine = pingRes ? (pingRes.error ? ` · Ping error: ${pingRes.error}` : ` · ${pingRes.direct ? 'Direct' : `Relay (${pingRes.derpRegionCode || '?'})`} ${pingRes.latencyMs != null ? `${pingRes.latencyMs} ms` : ''}`) : ''
							return (
								<div className="row static" key={p.id} style={{minHeight: 62}}>
									<span className="row-ico" style={{'--c': p.online ? 'var(--green)' : '#8e8e93'} as CSSProperties}>
										<Icon name="devices" size={18} />
									</span>
									<span className="main">
										<b style={{fontWeight: 550}}>{p.hostName || p.dnsName || p.id}</b>
										<span>
											{[p.os, ip, pathLabel].filter(Boolean).join(' · ')}
											{exitBadge}
											{traffic}
											{pingLine}
										</span>
									</span>
									{ip && (
										<button type="button" className="btn small" disabled={pinging === p.id} onClick={() => pingPeer(p)}>
											{pinging === p.id ? '…' : 'Ping'}
										</button>
									)}
								</div>
							)
						})}
						{d.peers.length === 0 && <div className="row static muted">No other devices on this tailnet yet.</div>}
					</Group>
				</>
			)}
		</Sheet>
	)
}
