import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import {cpSync, readFileSync, realpathSync} from 'node:fs'

import {apiProxy} from './vite.api-proxy.mjs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))

// The PDF viewer (pdf.js) loads its character maps and standard fonts on demand from /pdfjs/.
const pdfjsAssets = {
	name: 'pdfjs-assets',
	writeBundle() {
		for (const dir of ['cmaps', 'standard_fonts', 'wasm'])
			cpSync(`node_modules/pdfjs-dist/${dir}`, `dist/pdfjs/${dir}`, {recursive: true})
	},
}

export default defineConfig({
	root: 'web',
	plugins: [react(), pdfjsAssets],
	// The version this bundle was built as, so a page left open can tell when the server has moved on.
	define: {__TOUCH_BUILD__: JSON.stringify(pkg.version)},
	build: {outDir: '../dist', emptyOutDir: true, sourcemap: false},
	// node_modules may be a symlink to another worktree. Vite serves the real path, which
	// sits outside the project, so fonts and other package files 403 unless it is allowed.
	server: {
		port: 5173,
		proxy: {'/api': apiProxy},
		fs: {allow: [realpathSync('.'), realpathSync('node_modules')]},
	},
})
