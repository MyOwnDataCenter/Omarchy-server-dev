// Home glance rings for each GPU. Labels match System live cards.
import type {GpuInfo} from './api'

export function shortGpuName(name: string) {
	return name.replace(/^NVIDIA GeForce /, '').replace(/^NVIDIA /, '').replace(/^AMD Radeon /, '').replace(/^Intel\(R\) /, '').replace(/^Intel /, '')
}

export function gpuGaugeItems(gpus: GpuInfo[]) {
	const many = gpus.length > 1
	return gpus.map((gpu) => ({
		k: many ? `GPU ${gpu.index}` : 'GPU',
		key: gpu.id,
		icon: 'gpu' as const,
		p: gpu.used ?? 0,
		sub: shortGpuName(gpu.name) || ' ',
		ready: gpu.used != null,
	}))
}
