import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FullConfig } from "@playwright/test";
import { removeFixtureTree } from "./fixtures/cleanup";
import { E2E_BINARY_CACHE, E2E_DATA_DIR, E2E_DESKTOP_CACHE } from "./fixtures/paths";
import { disposeFixtureResources } from "./fixtures/resources";

export default async function globalTeardown(config?: FullConfig): Promise<void> {
	const records = join(E2E_DATA_DIR, "workspaces.json");
	if (config && existsSync(records)) {
		const baseURL = config.projects[0]?.use.baseURL;
		if (!baseURL) throw new Error("Fixture teardown requires the isolated host URL");
		const workspaces: { id: string }[] = JSON.parse(readFileSync(records, "utf8"));
		await disposeFixtureResources(
			Number(new URL(baseURL).port),
			workspaces.map((workspace) => workspace.id),
		);
	}
	removeFixtureTree(E2E_DATA_DIR);
	removeFixtureTree(E2E_BINARY_CACHE);
	removeFixtureTree(E2E_DESKTOP_CACHE);
}
