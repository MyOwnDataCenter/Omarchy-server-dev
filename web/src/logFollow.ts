export function nearBottom(el: {scrollTop: number; scrollHeight: number; clientHeight: number}, slack = 48) {
	return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}
