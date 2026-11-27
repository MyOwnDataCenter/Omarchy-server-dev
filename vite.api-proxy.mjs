// Dev server proxy. The API rejects a request whose Origin host is not Host, and Vite's
// string proxy does not forward WebSocket upgrades or rewrite Origin.
export const API_ORIGIN = 'http://127.0.0.1:7780'

function setDevOrigin(proxyReq) {
	proxyReq.setHeader('Origin', API_ORIGIN)
}

export const apiProxy = {
	target: API_ORIGIN,
	ws: true,
	changeOrigin: true,
	configure(proxy) {
		proxy.on('proxyReq', setDevOrigin)
		proxy.on('proxyReqWs', setDevOrigin)
	},
}
