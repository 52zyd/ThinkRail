import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { COMPATIBLE_PROVIDERS_PROTOCOL_VERSION, WS_CHANNELS } from "@thinkrail/contracts";
import {
	expandModelGroup,
	openAppFresh,
	openWorkspaceChat,
	revealModelGroups,
} from "./fixtures/app";
import { shot } from "./fixtures/screenshots";
import { seedEnglishConfig } from "./fixtures/settingsConfig";
import { E2eWire } from "./fixtures/wire";

test.afterEach(async ({ baseURL }) => {
	await seedEnglishConfig(baseURL);
});

test("the highlighted preset configures independent services without changing active models", async ({
	page,
	context,
}) => {
	const methods: string[] = [];
	let failSave = true;
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const request = JSON.parse(String(message)) as { id?: string; method?: string };
			if (request.method) methods.push(request.method);
			if (request.method === "provider.compatibleSave" && failSave) {
				failSave = false;
				socket.send(
					JSON.stringify({
						id: request.id,
						ok: false,
						error: "fixture save failure",
						errorCode: "COMPATIBLE_CONFIG_FAILED",
					}),
				);
			} else server.send(message);
		});
	});
	const visits: string[] = [];
	await context.route("https://www.llaigw.com/**", async (route) => {
		visits.push(route.request().url());
		await route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><title>Fixture</title>",
		});
	});
	let authorization = "";
	let modelPath = "";
	const server = createServer((request, response) => {
		authorization = String(request.headers.authorization ?? "");
		modelPath = request.url ?? "";
		response.setHeader("Content-Type", "application/json");
		response.end(JSON.stringify({ data: [{ id: "preset-fixture-model" }] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing local fixture address");
		const baseUrl = `http://127.0.0.1:${address.port}/custom/v1`;
		const workspace = await openWorkspaceChat(page);
		const wire = await E2eWire.connect(Number(new URL(page.url()).port));
		try {
			const before = await wire.request("settings.update", { config: { locale: "zh-CN" } });
			const sessions = await wire.request("session.list", { workspaceId: workspace.id });
			await page.getByTestId("open-settings").click();
			const card = page.getByTestId("compatible-recommended");
			const configure = page.getByTestId("compatible-recommended-configure");
			const website = page.getByTestId("compatible-recommended-website");
			await expect(card).toContainText("玲珑AI");
			await expect(card).toContainText("https://www.llaigw.com/v1");
			await expect(configure).toHaveText("配置");
			await expect(website).toHaveText("访问官网");
			await expect(website).toHaveAttribute("href", "https://www.llaigw.com");
			await expect(website).toHaveAttribute("target", "_blank");
			await expect(website).toHaveAttribute("rel", "noopener noreferrer");
			await expect(card).toHaveClass(/bg-primary-subtle/);
			await expect(card).toHaveClass(/border-primary-soft/);
			await expect(page.getByTestId("settings-api-platform")).toHaveAttribute(
				"href",
				"https://www.llaigw.com/?code=evQTPh9E6u",
			);
			await page.setViewportSize({ width: 1280, height: 980 });
			await shot(card, "compatible-preset", "desktop-zh");
			await page.setViewportSize({ width: 390, height: 780 });
			expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
				true,
			);
			await shot(card, "compatible-preset", "mobile-zh");
			await configure.focus();
			await page.keyboard.press("Tab");
			await expect(website).toBeFocused();
			const opened = page.waitForEvent("popup");
			await page.keyboard.press("Enter");
			const popup = await opened;
			await expect(popup).toHaveURL("https://www.llaigw.com/");
			await popup.close();
			expect(visits).toEqual(["https://www.llaigw.com/"]);
			await configure.focus();
			await page.keyboard.press("Enter");
			const form = page.getByTestId("compatible-form");
			await expect(page.getByTestId("compatible-name")).toHaveValue("玲珑AI");
			await expect(page.getByTestId("compatible-url")).toHaveValue("https://www.llaigw.com/v1");
			await expect(page.getByTestId("compatible-api")).toHaveValue("openai-completions");
			await expect(page.getByTestId("compatible-key")).toHaveValue("");
			await expect(page.getByTestId("compatible-model-id")).toHaveValue("");
			await expect(page.getByTestId("compatible-no-key")).toHaveAttribute("aria-checked", "false");
			await expect(page.getByTestId("compatible-save")).toBeDisabled();
			expect(methods).not.toContain("provider.compatibleDiscover");
			expect(methods).not.toContain("provider.compatibleSave");
			await page.getByTestId("compatible-key").fill("discarded-fixture-key");
			await form.getByRole("button", { name: "取消", exact: true }).click();
			expect(await wire.request("provider.compatibleList", {})).toEqual([]);
			await page.getByTestId("compatible-add").click();
			await expect(page.getByTestId("compatible-name")).toHaveValue("");
			await expect(page.getByTestId("compatible-url")).toHaveValue("");
			await expect(page.getByTestId("compatible-key")).toHaveCount(0);
			await form.getByRole("button", { name: "取消", exact: true }).click();
			await configure.click();
			await expect(page.getByTestId("compatible-key")).toHaveValue("");
			await page.getByTestId("compatible-url").fill(baseUrl);
			await page.getByTestId("compatible-key").fill("preset-fixture-key");
			await page.getByTestId("compatible-discover").click();
			await page.getByTestId("compatible-discovered").selectOption("preset-fixture-model");
			expect(authorization).toBe("Bearer preset-fixture-key");
			expect(modelPath).toBe("/custom/v1/models");
			await page.getByTestId("compatible-save").click();
			await expect(form.getByRole("alert")).toContainText("models.json");
			await expect(page.getByTestId("compatible-key")).toHaveValue("preset-fixture-key");
			await expect(page.getByTestId("compatible-url")).toHaveValue(baseUrl);
			await expect(page.getByTestId("compatible-model-id")).toHaveValue("preset-fixture-model");
			await page.getByTestId("compatible-save").click();
			await expect(form).toHaveCount(0);
			const first = (await wire.request("provider.compatibleList", {}))[0];
			expect(first?.name).toBe("玲珑AI");
			await configure.click();
			await page.getByTestId("compatible-url").fill(baseUrl);
			await page.getByTestId("compatible-key").fill("second-fixture-key");
			await page.getByTestId("compatible-model-id").fill("preset-fixture-model");
			await page.getByTestId("compatible-api").selectOption("openai-responses");
			await page.getByTestId("compatible-save").click();
			await expect(form).toHaveCount(0);
			const providers = await wire.request("provider.compatibleList", {});
			expect(providers).toHaveLength(2);
			expect(new Set(providers.map((provider) => provider.id)).size).toBe(2);
			expect(providers[0]).toEqual(first);
			const after = await wire.request("settings.update", { config: {} });
			expect(after.defaultModel).toEqual(before.defaultModel);
			const afterSessions = await wire.request("session.list", { workspaceId: workspace.id });
			expect(afterSessions.map((session) => session.model)).toEqual(
				sessions.map((session) => session.model),
			);
			await wire.request("settings.update", { config: { locale: "en" } });
			await expect(configure).toHaveText("Configure");
			await expect(website).toHaveText("Visit website");
			await page.keyboard.press("Escape");
			await page.getByTestId("model-selector").last().click();
			await revealModelGroups(page);
			for (const provider of providers) {
				await expandModelGroup(page, provider.id);
				await expect(
					page.locator(
						`[data-testid="model-option"][data-provider="${provider.id}"][data-model-id="preset-fixture-model"]`,
					),
				).toBeVisible();
			}
			await page.keyboard.press("Escape");
		} finally {
			try {
				for (const provider of await wire.request("provider.compatibleList", {})) {
					await wire.request("provider.compatibleRemove", {
						id: provider.id,
						revision: provider.revision,
					});
				}
			} finally {
				wire.close();
			}
		}
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("older hosts hide the recommendation together with compatible-service controls", async ({
	page,
}) => {
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		const server = socket.connectToServer();
		server.onMessage((message) => {
			const frame = JSON.parse(String(message)) as {
				channel?: string;
				data: { protocolVersion: number };
			};
			if (frame.channel === WS_CHANNELS.serverWelcome) {
				frame.data.protocolVersion = COMPATIBLE_PROVIDERS_PROTOCOL_VERSION - 1;
				socket.send(JSON.stringify(frame));
			} else socket.send(message);
		});
	});
	await openAppFresh(page);
	await page.getByTestId("open-settings").click();
	await expect(page.getByTestId("settings-providers")).toBeVisible();
	await expect(page.getByTestId("compatible-providers")).toHaveCount(0);
	await expect(page.getByTestId("compatible-recommended")).toHaveCount(0);
});
