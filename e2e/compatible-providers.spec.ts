import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { openAppFresh, openWorkspaceChat } from "./fixtures/app";
import { E2E_SCREENSHOT_DIR } from "./fixtures/paths";
import { E2eWire } from "./fixtures/wire";

test("compatible services support Chinese CRUD, discovery, manual models and retained keys", async ({
	page,
}) => {
	let auth = "";
	const server = createServer((request, response) => {
		auth = String(request.headers.authorization ?? "");
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ data: [{ id: "fixture-model" }, { id: "another-model" }] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture address missing");
	const endpoint = `http://127.0.0.1:${address.port}/custom/v1`;
	await openAppFresh(page);
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		await wire.request("settings.update", { config: { locale: "zh-CN" } });
		await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
		await page.getByTestId("open-settings").click();
		await page.getByTestId("compatible-add").click();
		await page.getByTestId("compatible-name").fill("本地模型服务");
		await page.getByTestId("compatible-url").fill(endpoint);
		await page.getByTestId("compatible-no-key").click();
		await page.getByTestId("compatible-key").fill("e2e-compatible-secret");
		await page.getByTestId("compatible-discover").click();
		await expect(page.getByTestId("compatible-discovered")).toBeVisible();
		await page.getByTestId("compatible-discovered").selectOption("fixture-model");
		expect(auth).toBe("Bearer e2e-compatible-secret");
		await page.getByTestId("compatible-save").click();
		const row = page.getByTestId("compatible-provider");
		await expect(row).toContainText("本地模型服务");
		await expect(row).toContainText("已保存 Key");
		const list = await wire.request("provider.compatibleList", {});
		expect(JSON.stringify(list)).not.toContain("e2e-compatible-secret");
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
		await page.getByTestId("open-settings").click();
		await expect(row).toContainText("本地模型服务");
		await row.getByTestId("compatible-edit").click();
		await expect(page.getByTestId("compatible-key")).toHaveValue("");
		await page.getByTestId("compatible-api").selectOption("openai-responses");
		await page.getByTestId("compatible-add-model").click();
		await page.getByTestId("compatible-model-id").last().fill("manual-model");
		await page.getByTestId("compatible-save").click();
		await expect(row).toContainText("Responses");
		await row.getByTestId("compatible-edit").click();
		await page.getByTestId("compatible-discover").click();
		await expect(page.getByTestId("compatible-discovered")).toBeVisible();
		expect(auth).toBe("Bearer e2e-compatible-secret");
		const shots = join(E2E_SCREENSHOT_DIR, "compatible-providers");
		mkdirSync(shots, { recursive: true });
		await page.setViewportSize({ width: 1280, height: 1150 });
		await page.getByTestId("compatible-providers").getByRole("heading").scrollIntoViewIfNeeded();
		await page
			.getByTestId("settings-dialog")
			.screenshot({ path: join(shots, "providers-zh.png"), animations: "disabled" });
		await page.setViewportSize({ width: 1280, height: 1600 });
		await page.getByTestId("compatible-providers").scrollIntoViewIfNeeded();
		await page.getByTestId("compatible-providers").screenshot({
			path: join(shots, "compatible-service-zh.png"),
			animations: "disabled",
		});
		await page.setViewportSize({ width: 390, height: 780 });
		await expect(page.getByTestId("compatible-save")).toBeVisible();
		expect(
			await page
				.getByTestId("compatible-form")
				.evaluate((element) => element.scrollWidth <= element.clientWidth),
		).toBe(true);
		await page.getByTestId("settings-dialog").screenshot({
			path: join(shots, "providers-mobile-zh.png"),
			animations: "disabled",
		});
		await page.getByTestId("compatible-no-key").click();
		await page.getByTestId("compatible-save").click();
		await expect(row).toContainText("此服务无需 Key");
		await row.getByTestId("compatible-remove").click();
		await page.getByTestId("compatible-remove-confirm").click();
		await expect(row).toHaveCount(0);
	} finally {
		const providers = await wire.request("provider.compatibleList", {});
		for (const provider of providers)
			await wire.request("provider.compatibleRemove", {
				id: provider.id,
				revision: provider.revision,
			});
		await wire.request("settings.update", { config: { locale: "en" } });
		wire.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("open chats prevent provider removal; failed discovery keeps manual entry usable", async ({
	page,
}) => {
	const workspace = await openWorkspaceChat(page);
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	let sessionId: string | undefined;
	try {
		const provider = await wire.request("provider.compatibleSave", {
			name: "Offline service",
			baseUrl: "http://127.0.0.1:1/v1",
			api: "openai-completions",
			models: [{ id: "offline-model" }],
			apiKey: null,
		});
		const models = await wire.request("model.list", {});
		const model = models.find((model) => model.provider === provider.id);
		if (!model) throw new Error("Custom model missing from picker catalog");
		const session = await wire.request("session.create", { workspaceId: workspace.id, model });
		sessionId = session.sessionId;
		await expect(
			wire.request("provider.compatibleRemove", { id: provider.id, revision: provider.revision }),
		).rejects.toThrow("provider.compatibleRemove failed on the isolated host wire");
		await page.getByTestId("open-settings").click();
		const row = page.getByTestId("compatible-provider");
		await row.getByTestId("compatible-remove").click();
		await page.getByTestId("compatible-remove-confirm").click();
		await expect(page.getByTestId("compatible-providers").getByRole("alert")).toContainText(
			"This service is in use",
		);
		await row.getByTestId("compatible-edit").click();
		await page.getByTestId("compatible-no-key").click();
		await page.getByTestId("compatible-key").fill("draft-kept-on-failure");
		await page.getByTestId("compatible-save").click();
		await expect(page.getByTestId("compatible-form").getByRole("alert")).toContainText(
			"This service is in use",
		);
		await expect(page.getByTestId("compatible-key")).toHaveValue("draft-kept-on-failure");
		await wire.request("session.dispose", { sessionId });
		sessionId = undefined;
		await page.getByTestId("compatible-discover").click();
		await expect(page.getByTestId("compatible-form").getByRole("alert")).toContainText(
			"Could not fetch models",
		);
		await expect(page.getByTestId("compatible-model-id")).toHaveValue("offline-model");
		await page.getByTestId("compatible-model-id").fill("manually-added");
		await page.getByTestId("compatible-save").click();
		await expect(page.getByTestId("compatible-form")).toHaveCount(0);
	} finally {
		if (sessionId) await wire.request("session.dispose", { sessionId });
		for (const provider of await wire.request("provider.compatibleList", {}))
			await wire.request("provider.compatibleRemove", {
				id: provider.id,
				revision: provider.revision,
			});
		wire.close();
	}
});
