import { expect, test } from "@playwright/test";
import { shot } from "./fixtures/screenshots";
import { seedEnglishConfig } from "./fixtures/settingsConfig";
import { E2eWire } from "./fixtures/wire";

test.afterEach(async ({ baseURL }) => {
	await seedEnglishConfig(baseURL);
});

test("privacy and consent controls are absent after reload with legacy preferences", async ({
	page,
	baseURL,
}) => {
	await seedEnglishConfig(baseURL);
	if (!baseURL) throw new Error("Missing isolated host URL");
	const wire = await E2eWire.connect(Number(new URL(baseURL).port));
	try {
		const config = { locale: "zh-CN" };
		Reflect.set(config, "analyticsEnabled", true);
		Reflect.set(config, "analyticsConsentConfirmed", false);
		const saved = await wire.request("settings.update", { config });
		expect(saved).not.toHaveProperty("analyticsEnabled");
		expect(saved).not.toHaveProperty("analyticsConsentConfirmed");
	} finally {
		wire.close();
	}
	const reports: string[] = [];
	page.on("websocket", (socket) => {
		socket.on("framesent", ({ payload }) => {
			if (String(payload).includes('"client.reportError"')) reports.push(String(payload));
		});
	});
	await page.goto("/");
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await page.getByTestId("open-settings").click();
	const dialog = page.getByTestId("settings-dialog");
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId("settings-nav-privacy")).toHaveCount(0);
	await expect(page.getByTestId("analytics-toggle")).toHaveCount(0);
	await expect(page.getByTestId("analytics-consent-dialog")).toHaveCount(0);
	await shot(dialog, "settings", "without-telemetry-zh");
	await page.evaluate(() => {
		window.dispatchEvent(new ErrorEvent("error", { error: new Error("local-only fault") }));
	});
	await page.reload();
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");
	await expect(page.getByTestId("analytics-consent-dialog")).toHaveCount(0);
	expect(reports).toEqual([]);
});
