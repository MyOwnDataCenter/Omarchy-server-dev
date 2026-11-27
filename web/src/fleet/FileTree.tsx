// Folders that open in place, as a tree, the way Favorites and Recent do. One tree per place:
// a folder on this server, a connected computer's home folder, or a virtual machine's (through
// its connector). Each level is listed only when it's opened.
import {useQuery} from '@tanstack/react-query'
import {useState, type ReactNode} from 'react'

import {query, type FileEntry, type Listing} from '../api'
import {Icon, type IconName} from '../icons'
import {bytes, haptic} from '../ui'

export type TreeSource = {kind: 'server'} | {kind: 'computer'; id: string}

type Node = {name: string; path: string; dir: boolean; size?: number; entry?: FileEntry}

const join = (rel: string, name: string) => (rel ? `${rel}/${name}` : name)

function useChildren(source: TreeSource, path: string) {
	return useQuery({
		queryKey: source.kind === 'server' ? ['files.list', path, 'name', 0] : ['swarm.files.list', source.id, path],
		queryFn: async (): Promise<{nodes: Node[]; more: boolean}> => {
			if (source.kind === 'server') {
				const listing = await query<Listing>('files.list', {path, sortBy: 'name', sortOrder: 'ascending'})
				return {nodes: listing.files.map((f) => ({name: f.name, path: f.path, dir: f.type === 'directory', size: f.size, entry: f})), more: !!listing.hasMore}
			}
			const listing = await query<{entries: {name: string; size: number; dir: boolean}[]; truncated?: boolean}>('swarm.files.list', {id: source.id, path})
			return {nodes: listing.entries.map((e) => ({name: e.name, path: join(path, e.name), dir: e.dir, size: e.size})), more: !!listing.truncated}
		},
		staleTime: 10_000,
	})
}

export type TreeActions = {
	/** Go into a folder in the main view (with uploads, selection and the rest). */
	onOpenFolder: (source: TreeSource, path: string) => void
	/** Open a file. Server files come with their entry. */
	onOpenFile: (source: TreeSource, node: {path: string; entry?: FileEntry}) => void
}

/** What's inside `path`, folders first, each folder opening in place. */
export function TreeChildren({source, path, depth, actions}: {source: TreeSource; path: string; depth: number; actions: TreeActions}) {
	const children = useChildren(source, path)
	if (children.isLoading) return <div className="ftree-note" style={{'--depth': depth} as React.CSSProperties}>Loading…</div>
	if (children.error) return <div className="ftree-note error-text" style={{'--depth': depth} as React.CSSProperties}>{(children.error as Error).message}</div>
	const nodes = [...(children.data?.nodes ?? [])].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, {numeric: true}))
	if (!nodes.length) return <div className="ftree-note" style={{'--depth': depth} as React.CSSProperties}>Empty folder</div>
	return (
		<ul className="ftree" role="group">
			{nodes.map((n) =>
				n.dir ? (
					<TreeFolder key={n.path} source={source} path={n.path} name={n.name} depth={depth} actions={actions} />
				) : (
					<li key={n.path}>
						<button type="button" className="ftree-row" style={{'--depth': depth} as React.CSSProperties} onClick={() => (haptic(5), actions.onOpenFile(source, {path: n.path, entry: n.entry}))}>
							<span className="ftree-chev" />
							<Icon name="file" size={16} />
							<span className="ftree-name">{n.name}</span>
							{n.size != null && <span className="ftree-size">{bytes(n.size)}</span>}
						</button>
					</li>
				),
			)}
			{children.data?.more && (
				<li>
					<button type="button" className="ftree-row ftree-more" style={{'--depth': depth} as React.CSSProperties} onClick={() => actions.onOpenFolder(source, path)}>
						<span className="ftree-chev" />
						Show all in this folder
					</button>
				</li>
			)}
		</ul>
	)
}

/** One folder: tap to open it in place; the arrow on the right goes into it. */
export function TreeFolder({source, path, name, depth, actions, icon = 'folder', sub, open: startOpen = false}: {source: TreeSource; path: string; name: string; depth: number; actions: TreeActions; icon?: IconName; sub?: string; open?: boolean}) {
	const [open, setOpen] = useState(startOpen)
	return (
		<li>
			<div className={`ftree-row ftree-folder${open ? ' open' : ''}`} style={{'--depth': depth} as React.CSSProperties}>
				<button type="button" className="ftree-toggle" aria-expanded={open} onClick={() => (haptic(5), setOpen(!open))}>
					<Icon name="chevron" size={14} className="ftree-chev" />
					<Icon name={icon} size={16} />
					<span className="ftree-name">{name}</span>
					{sub && <span className="ftree-size">{sub}</span>}
				</button>
				<button type="button" className="ftree-go" aria-label={`Open ${name}`} title="Open folder" onClick={() => (haptic(5), actions.onOpenFolder(source, path))}>
					<Icon name="back" size={14} style={{transform: 'rotate(180deg)'}} />
				</button>
			</div>
			{open && <TreeChildren source={source} path={path} depth={depth + 1} actions={actions} />}
		</li>
	)
}

export type TreeMachine = {key: string; name: string; kind: 'computer' | 'vm'; agentId?: string; ready: boolean; note: string}

/** The connected computers and the virtual machines on this server, each a tree of its home folder. */
export function MachineTrees({machines, actions, title = 'Computers and virtual machines'}: {machines: TreeMachine[]; actions: TreeActions; title?: string}) {
	if (!machines.length) return null
	return (
		<section className="ftree-section">
			<div className="section-head">
				<h2>{title}</h2>
			</div>
			<ul className="ftree glass ftree-root" role="tree">
				{machines.map((m): ReactNode =>
					m.ready && m.agentId ? (
						<TreeFolder key={m.key} source={{kind: 'computer', id: m.agentId}} path="" name={m.name} sub={m.note} depth={0} actions={actions} icon={m.kind === 'vm' ? 'machine' : 'devices'} />
					) : (
						<li key={m.key}>
							<div className="ftree-row ftree-off" style={{'--depth': 0} as React.CSSProperties}>
								<span className="ftree-chev" />
								<Icon name={m.kind === 'vm' ? 'machine' : 'devices'} size={16} />
								<span className="ftree-name">{m.name}</span>
								<span className="ftree-size">{m.note}</span>
							</div>
						</li>
					),
				)}
			</ul>
		</section>
	)
}
