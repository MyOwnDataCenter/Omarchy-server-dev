// A proxied request lives exactly as long as both ends do. When the client goes away the request
// to the far side is destroyed, so a stream (server-sent events, a download, an upload) stops
// there too. When the far side breaks mid-response the client's connection is destroyed instead
// of left waiting on a response that will never finish.
export function linkProxy(req, res, up) {
	const stop = () => up.destroyed || up.destroy()
	res.on('close', () => {
		if (!res.writableFinished) stop()
	})
	req.on('aborted', stop)
	up.on('response', (ur) => {
		const broken = () => res.destroyed || res.destroy()
		ur.on('error', broken)
		ur.on('aborted', broken)
		ur.on('close', () => {
			if (!ur.complete) broken()
		})
	})
	// After headers went out, an error can't become a clean 502: cut the connection.
	up.on('error', () => {
		if (res.headersSent && !res.writableFinished) res.destroy()
	})
}
