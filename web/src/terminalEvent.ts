// Ask the page to open My Own Data Center's terminal with a command typed in (not run: you press
// Enter). The phone layout (App.tsx) and the desktop (desktop/Desktop.tsx) listen for it.
export const OPEN_TERMINAL = 'omarchy:open-terminal'
export const openTerminalWith = (input: string) => window.dispatchEvent(new CustomEvent<string>(OPEN_TERMINAL, {detail: input}))
