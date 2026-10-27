import { E2eWire } from "./wire";

export async function disposeFixtureResources(port: number, workspaceIds: string[]): Promise<void> {
	if (workspaceIds.length === 0) return;
	const wire = await E2eWire.connect(port);
	try {
		for (const workspaceId of workspaceIds) {
			const sessions = await wire.request("session.list", { workspaceId }, 30_000);
			for (const session of sessions) {
				if (session.live)
					await wire.request("session.dispose", { sessionId: session.sessionId }, 30_000);
			}
			const { tabs } = await wire.request("terminal.list", { workspaceId });
			for (const tab of tabs)
				await wire.request("terminal.close", { workspaceId, tabKey: tab.tabKey, force: true });
		}
	} finally {
		wire.close();
	}
}
