// Terminal for omarchyd: your login shell (or a shell inside an app's container) in a real pseudo-
// terminal, over a WebSocket. The pty comes from util-linux `script`, which every Arch system has,
// so there is no native module to build. Runs as you, like the rest of omarchyd.
//
// Shells persist: closing the terminal (or losing the connection, or switching devices) leaves the
// shell running, and opening it again picks up where you left off, with what was on screen. A shell
// ends when you `exit` it, ask for a new one, or omarchyd itself stops (a restart or an update).
import {execFile, spawn} from 'node:child_process'
import {readdir, readFile, readlink} from 'node:fs/promises'
import os from 'node:os'

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// Start a shell in a pty. `command` is an argv run instead of the login shell (for app shells).
export function openShell({cols, rows, command = null, cwd = os.homedir(), env = process.env, home = os.homedir()}) {
	const shell = env.SHELL && /^\/[\w/.-]+$/.test(env.SHELL) ? env.SHELL : '/bin/bash'
	const inner = command ? command.map(quote).join(' ') : `${quote(shell)} -l`
	return spawn('script', ['-q', '-f', '-e', '-c', `stty cols ${cols} rows ${rows} 2>/dev/null; exec ${inner}`, '/dev/null'], {
		cwd,
		env: {...env, HOME: home, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: env.LANG || 'C.UTF-8'},
	})
}

// The pty `script` made for the shell: the terminal device its child reads from (/dev/pts/N).
async function ptyOf(pid) {
	for (const p of await readdir('/proc').catch(() => [])) {
		if (!/^\d+$/.test(p)) continue
		const stat = await readFile(`/proc/${p}/stat`, 'utf8').catch(() => '')
		// pid (comm) state ppid ... — comm can hold spaces and parentheses, so read after the last ')'.
		if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) !== pid) continue
		const tty = await readlink(`/proc/${p}/fd/0`).catch(() => '')
		if (/^\/dev\/pts\/\d+$/.test(tty)) return tty
	}
	return null
}

const KEEP = 512 * 1024 // what's replayed when you come back: the most recent output, up to this much
const MAX_SESSIONS = 12 // per person (your shell plus app shells); the oldest unused one goes first

// Persistent shells, one per person and place (your own shell, or one per app).
export function createTerminalSessions({exec = execFile} = {}) {
	const sessions = new Map() // `${userId}:${appId || ''}` -> session

	const resize = async (s, cols, rows) => {
		s.pty ??= await ptyOf(s.child.pid)
		if (!s.pty) return false
		// Setting the size signals the programs running in it (SIGWINCH), so full-screen ones redraw.
		await new Promise((r) => exec('stty', ['-F', s.pty, 'cols', String(cols), 'rows', String(rows)], () => r()))
		s.cols = cols
		s.rows = rows
		return true
	}

	const end = (key, s) => {
		if (sessions.get(key) === s) sessions.delete(key)
		// `script` ignores SIGHUP; on SIGTERM it stops and the kernel hangs up the shell inside.
		if (s.child.exitCode === null) s.child.kill('SIGTERM')
	}

	function start(key, {cols, rows, shell}) {
		const child = openShell({cols, rows, ...shell})
		const s = {child, cols, rows, chunks: [], size: 0, sockets: new Set(), used: Date.now(), pty: null}
		const out = (d) => {
			s.chunks.push(d)
			s.size += d.length
			// Keep the most recent output, starting on a line boundary so nothing replays half-cut.
			if (s.size > KEEP * 1.5) {
				let all = Buffer.concat(s.chunks)
				all = all.subarray(all.length - KEEP)
				const nl = all.indexOf(10)
				if (nl >= 0 && nl < 4096) all = all.subarray(nl + 1)
				s.chunks = [all]
				s.size = all.length
			}
			for (const ws of s.sockets) if (ws.readyState === ws.OPEN) ws.send(d, {binary: true})
		}
		child.stdout.on('data', out)
		child.stderr.on('data', out)
		const closeAll = (code, why) => {
			if (sessions.get(key) === s) sessions.delete(key)
			for (const ws of s.sockets) if (ws.readyState === ws.OPEN) ws.close(code, why)
			s.sockets.clear()
		}
		child.on('exit', () => closeAll(1000, 'Shell ended'))
		child.on('error', () => closeAll(1011, 'Couldn’t start a shell'))
		// Never more than a few at once: the one left alone longest stops first.
		const mine = [...sessions].filter(([k]) => k.startsWith(key.split(':')[0] + ':'))
		if (mine.length >= MAX_SESSIONS) {
			const [oldKey, old] = mine.filter(([, x]) => !x.sockets.size).sort((a, b) => a[1].used - b[1].used)[0] ?? mine.sort((a, b) => a[1].used - b[1].used)[0]
			end(oldKey, old)
		}
		sessions.set(key, s)
		return s
	}

	// Attach a WebSocket: to the shell that's already there (resumed), or a new one.
	// `fresh` ends the old shell first. `shell` is how to start one ({command, cwd, env, home}).
	async function attach(ws, {userId, appId = '', cols, rows, fresh = false, shell = {}}) {
		const key = `${userId}:${appId}`
		let s = sessions.get(key)
		if (s && (fresh || s.child.exitCode !== null)) {
			end(key, s)
			s = null
		}
		const resumed = !!s
		if (!s) s = start(key, {cols, rows, shell})
		s.used = Date.now()
		// Control messages are text frames; the shell's output is always binary.
		const tell = (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m))
		if (resumed) {
			// What was on screen, at the size it was drawn, then this device's size (the terminal
			// reflows, and full-screen programs redraw for it).
			tell({type: 'session', resumed: true, cols: s.cols, rows: s.rows})
			const replay = Buffer.concat(s.chunks)
			if (replay.length && ws.readyState === ws.OPEN) ws.send(replay, {binary: true})
			s.sockets.add(ws) // from here on it gets what the shell writes, like any other
			if (s.cols !== cols || s.rows !== rows) {
				if (await resize(s, cols, rows)) tell({type: 'size', cols, rows})
			} else if (await resize(s, cols, Math.max(4, rows - 1))) {
				// Same size: nudge it anyway so full-screen programs repaint over the replay.
				await resize(s, cols, rows)
			}
		} else {
			tell({type: 'session', resumed: false, cols, rows})
			s.sockets.add(ws)
		}
		ws.on('message', (d) => {
			s.used = Date.now()
			if (s.child.stdin.writable) s.child.stdin.write(d)
		})
		// Closing the terminal only lets go of the shell; it keeps running.
		const leave = () => {
			s.sockets.delete(ws)
			s.used = Date.now()
		}
		ws.on('close', leave)
		ws.on('error', leave)
		return {resumed}
	}

	return {
		attach,
		// For tests and Settings: which shells are running.
		list: () => [...sessions].map(([key, s]) => ({key, cols: s.cols, rows: s.rows, attached: s.sockets.size, used: s.used})),
		close() {
			for (const [key, s] of sessions) end(key, s)
		},
	}
}
