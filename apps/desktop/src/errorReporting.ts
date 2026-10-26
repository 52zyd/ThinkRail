export function desktopError(_scope: string, message: string, error?: unknown): void {
	if (error === undefined) console.error(`[desktop] ${message}`);
	else console.error(`[desktop] ${message}`, error);
}
