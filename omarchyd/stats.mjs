// Background samples of live system stats. Each field has its own interval.
// Sampling runs only while something is reading, and stops about 15s after the
// last read. The next read returns the last snapshot immediately and refreshes.
// snapshot() and get() are memory reads for the caller. They do not wait on hardware
// except the very first get(), which waits for that first tick so the first look is
// not empty. The GPU read is left running. Scheduling uses a monotonic clock so a
// step of the wall clock does not freeze the gauges. The wall clock is only the
// sampledAt time shown to the user.

export const DEFAULT_INTERVALS = {
	cpu: 1_000,
	memory: 1_000,
	gpu: 1_000,
	temp: 5_000,
	battery: 5_000,
	disk: 30_000,
	uptime: 60_000,
	breakdown: 15_000,
}

const TICK_MS = 250
export const IDLE_MS = 15_000

export function emptySnapshot() {
	return {
		cpu: {threads: 0, totalUsed: 0, system: 0, apps: [], machines: []},
		memory: {size: 0, totalUsed: 0, system: 0, apps: [], machines: []},
		disk: {size: 0, totalUsed: 0, available: 0, system: 0, files: 0, apps: [], machines: [], measuring: true, drive: null},
		temp: {warning: 'normal', temperature: null},
		gpu: {gpus: []},
		battery: {batteries: []},
		uptime: 0,
		sampledAt: {cpu: 0, memory: 0, gpu: 0, temp: 0, battery: 0, disk: 0, uptime: 0, breakdown: 0},
	}
}

function mapUsage(total, kind, breakdown) {
	const threads = total.threads || 1
	const value = (u) =>
		kind === 'cpu' ? Math.round(Math.min(100, (100 * (u.cpuShare ?? 0)) / threads) * 10) / 10 : Math.round(u.memBytes ?? 0)
	const apps = (breakdown.apps ?? [])
		.map((u) => ({id: u.id, used: value(u), ...(u.name ? {name: u.name} : {})}))
		.filter((u) => u.used > 0)
	const machines = (breakdown.machines ?? [])
		.map((u) => ({id: u.id, ...(u.name ? {name: u.name} : {}), used: value(u)}))
		.filter((u) => u.used > 0)
	const counted = [...apps, ...machines].reduce((n, u) => n + u.used, 0)
	return {...total, apps, machines, system: Math.max(0, total.totalUsed - counted)}
}

export function createSampler({
	now = Date.now,
	mono,
	intervals = DEFAULT_INTERVALS,
	read,
	setIntervalFn = setInterval,
	clearIntervalFn = clearInterval,
	setTimeoutFn = setTimeout,
} = {}) {
	// Tests pass their own now and drive the schedule with it. Production leaves now
	// as Date.now and schedules with performance.now, which does not step backward.
	const schedule = mono ?? (now === Date.now ? () => performance.now() : now)
	const lastAt = {}
	const pending = new Set()
	let snap = emptySnapshot()
	let lastBreakdown = {apps: [], machines: []}
	let timer = null
	let inflight = null
	let stopped = false
	let lastRead = 0

	const due = (key) => {
		if (pending.has(key) || !read?.[key]) return false
		if (lastAt[key] == null) return true
		const elapsed = schedule() - lastAt[key]
		return elapsed < 0 || elapsed >= (intervals[key] ?? DEFAULT_INTERVALS[key])
	}

	function applyBreakdown() {
		if (snap.cpu) snap.cpu = mapUsage(snap.cpu, 'cpu', lastBreakdown)
		if (snap.memory) snap.memory = mapUsage(snap.memory, 'memory', lastBreakdown)
	}

	// The attempt is recorded when the read starts. A failure still waits out the
	// interval, and a read that is already running is not started again.
	function sample(key, apply) {
		if (!due(key)) return null
		lastAt[key] = schedule()
		pending.add(key)
		let pendingRead
		try {
			pendingRead = read[key]()
		} catch (error) {
			pendingRead = Promise.reject(error)
		}
		return Promise.resolve(pendingRead)
			.then((v) => {
				apply(v)
				snap.sampledAt[key] = now()
			})
			.catch(() => {})
			.finally(() => pending.delete(key))
	}

	async function tick({waitGpu = true} = {}) {
		if (stopped) return snap
		const jobs = []
		const job = (p) => p && jobs.push(p)
		job(sample('breakdown', (b) => (lastBreakdown = b ?? {apps: [], machines: []})))
		job(sample('cpu', (v) => (snap.cpu = v)))
		job(sample('memory', (v) => (snap.memory = v)))
		job(sample('temp', (v) => (snap.temp = v)))
		job(sample('battery', (v) => (snap.battery = v)))
		job(sample('disk', (v) => (snap.disk = v)))
		job(sample('uptime', (v) => (snap.uptime = v)))
		const gpuJob = sample('gpu', (v) => (snap.gpu = v))
		if (jobs.length) await Promise.all(jobs)
		applyBreakdown()
		if (gpuJob && waitGpu) await gpuJob
		else if (gpuJob) void gpuJob
		return snap
	}

	function pause() {
		if (timer == null) return
		clearIntervalFn(timer)
		timer = null
	}

	function arm() {
		if (stopped || timer != null) return
		const kick = () => {
			if (stopped) return
			if (schedule() - lastRead >= IDLE_MS) {
				pause()
				return
			}
			void tick({waitGpu: false})
		}
		timer = setIntervalFn(kick, TICK_MS)
		timer?.unref?.()
	}

	// A read keeps the timer alive. Coming back from idle returns the snapshot the
	// caller already has and refreshes on the next turn, without waiting.
	function touch({refresh = true} = {}) {
		lastRead = schedule()
		if (stopped) return
		const wasIdle = timer == null
		arm()
		if (!wasIdle || !refresh || lastAt.cpu == null) return
		const later = setTimeoutFn(() => {
			if (!stopped && timer != null && schedule() - lastRead < IDLE_MS) void tick({waitGpu: false})
		}, 0)
		later?.unref?.()
	}

	function snapshot() {
		touch()
		return snap
	}

	async function get() {
		if (stopped) return snap
		const cold = lastAt.cpu == null
		touch({refresh: !cold})
		if (cold) {
			inflight ??= tick({waitGpu: false}).finally(() => (inflight = null))
			await inflight
		}
		return snap
	}

	function start() {
		stopped = false
	}

	function stop() {
		stopped = true
		pause()
	}

	return {tick, snapshot, get, start, stop}
}
