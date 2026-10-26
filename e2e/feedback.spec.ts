import { expect, test, type WebSocketRoute } from "@playwright/test";
import { WS_CHANNELS } from "@thinkrail/contracts";
import { openAppFresh } from "./fixtures/app";
import { shot } from "./fixtures/screenshots";
import { E2eWire } from "./fixtures/wire";

const API_PLATFORM_URL = "https://www.llaigw.com/?code=evQTPh9E6u";
const BOOKING_URL = "https://calendar.app.google/5suMJdDEBFvYJ4zN9";
const INVITATION_COPY =
	"Tell us about your experience with ThinkRail in a user interview. After you complete the interview, you will receive 100 bonus credits in Central (JetBrains AI).";

type ClientRequest = {
	id?: string;
	method?: string;
	params?: { action?: string };
};

function sendInvitation(socket: WebSocketRoute | undefined): void {
	if (!socket) throw new Error("expected the app WebSocket");
	socket.send(JSON.stringify({ channel: WS_CHANNELS.feedbackInterview, data: {} }));
}

test("the API-platform footer preserves its URL, language, layout and keyboard behavior", async ({
	context,
	page,
}) => {
	const requests: string[] = [];
	await context.route("https://www.llaigw.com/**", async (route) => {
		requests.push(route.request().url());
		await route.fulfill({
			contentType: "text/html",
			body: "<!doctype html><title>Test fixture</title>",
		});
	});
	await openAppFresh(page);
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		await page.getByTestId("open-settings").click();
		await page.getByTestId("settings-nav-providers").click();
		const dialog = page.getByTestId("settings-dialog");
		const link = page.getByTestId("settings-api-platform");
		await expect(link).toHaveText("Recommended API platform: 玲珑");
		await expect(link).toHaveAttribute("href", API_PLATFORM_URL);
		await expect(link).toHaveAttribute("target", "_blank");
		await expect(link).toHaveAttribute("rel", "noopener noreferrer");
		await expect(page.getByTestId("settings-nav-feedback")).toHaveCount(0);
		const clickedPopup = page.waitForEvent("popup");
		await link.click();
		const clicked = await clickedPopup;
		await expect(clicked).toHaveURL(API_PLATFORM_URL);
		await clicked.close();
		await expect(page.getByTestId("settings-providers")).toBeVisible();
		await expect(dialog).toBeVisible();
		await wire.request("settings.update", { config: { locale: "zh-CN" } });
		await expect(link).toHaveText("推荐 API 接入平台玲珑");
		await page.setViewportSize({ width: 1280, height: 1000 });
		await shot(dialog, "settings-api-platform", "desktop-zh");
		await page.setViewportSize({ width: 390, height: 780 });
		await dialog.locator("nav").getByRole("button").last().focus();
		await page.keyboard.press("Tab");
		await expect(link).toBeFocused();
		expect(await link.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		const bounds = await link.boundingBox();
		if (!bounds) throw new Error("Footer link is missing");
		expect(bounds.x).toBeGreaterThanOrEqual(0);
		expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
		await shot(dialog, "settings-api-platform", "mobile-zh");
		const keyboardPopup = page.waitForEvent("popup");
		await page.keyboard.press("Enter");
		const keyboard = await keyboardPopup;
		await expect(keyboard).toHaveURL(API_PLATFORM_URL);
		await keyboard.close();
		await expect(page.getByTestId("settings-providers")).toBeVisible();
		await expect(page.getByTestId("settings-feedback")).toHaveCount(0);
		expect(requests).toContain(API_PLATFORM_URL);
	} finally {
		await wire.request("settings.update", { config: { locale: "en" } });
		wire.close();
	}
});

test("the addressed interview prompt preserves the approved lifecycle", async ({
	context,
	page,
}) => {
	let browserSocket: WebSocketRoute | undefined;
	let welcomeFrame: string | undefined;
	let rejectNextResponse = false;
	const actions: string[] = [];

	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		browserSocket = socket;
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const raw = typeof message === "string" ? message : message.toString();
			let request: ClientRequest;
			try {
				request = JSON.parse(raw) as ClientRequest;
			} catch {
				server.send(message);
				return;
			}
			if (request.method === "feedback.respond" && request.id) {
				actions.push(request.params?.action ?? "");
				if (rejectNextResponse) {
					rejectNextResponse = false;
					socket.send(
						JSON.stringify({ id: request.id, ok: false, error: "feedback response failed" }),
					);
					return;
				}
			}
			server.send(message);
		});
		server.onMessage((message) => {
			const raw = typeof message === "string" ? message : message.toString();
			try {
				const frame = JSON.parse(raw) as { channel?: string };
				if (frame.channel === WS_CHANNELS.serverWelcome) welcomeFrame = raw;
			} catch {}
			socket.send(message);
		});
	});
	await context.route("https://calendar.app.google/**", (route) => route.abort());

	await page.goto("/");
	await expect(page.getByTestId("connection-status")).toHaveAttribute("data-status", "connected");

	const primaryTextColor = await page.evaluate(() => {
		const probe = document.createElement("span");
		probe.className = "text-control-primary-text";
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	sendInvitation(browserSocket);
	const dialog = page.getByTestId("interview-prompt-dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("Help shape ThinkRail");
	await expect(dialog).toContainText(INVITATION_COPY);
	await expect(dialog.getByTestId("interview-postpone")).toBeFocused();

	rejectNextResponse = true;
	await dialog.getByTestId("interview-postpone").click();
	await expect(dialog).toBeVisible();
	await expect(
		page
			.locator('[data-testid="toast"][data-variant="error"]')
			.filter({ hasText: "feedback response failed" }),
	).toBeVisible();
	await dialog.getByTestId("interview-postpone").click();
	await expect(dialog).toBeHidden();
	await expect.poll(() => actions).toEqual(["postpone", "postpone"]);

	sendInvitation(browserSocket);
	await expect(dialog).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect.poll(() => actions.at(-1)).toBe("postpone");

	sendInvitation(browserSocket);
	await expect(dialog).toBeVisible();
	await dialog.getByRole("button", { name: "Close" }).click();
	await expect(dialog).toBeHidden();
	await expect.poll(() => actions.at(-1)).toBe("postpone");

	sendInvitation(browserSocket);
	await expect(dialog).toBeVisible();
	await page.getByTestId("dialog-overlay").click({ position: { x: 4, y: 4 } });
	await expect(dialog).toBeHidden();
	await expect.poll(() => actions.at(-1)).toBe("postpone");

	sendInvitation(browserSocket);
	await expect(dialog).toBeVisible();
	await dialog.getByTestId("interview-never").click();
	await expect(dialog).toBeHidden();
	await expect.poll(() => actions.at(-1)).toBe("never");

	sendInvitation(browserSocket);
	await expect(dialog).toBeVisible();
	if (!welcomeFrame) throw new Error("expected the host welcome frame");
	browserSocket?.send(welcomeFrame);
	await expect(dialog).toBeHidden();

	sendInvitation(browserSocket);
	await expect(dialog).toBeVisible();
	const bookingLink = dialog.getByTestId("interview-book");
	await expect(bookingLink).toHaveAttribute("href", BOOKING_URL);
	await expect(bookingLink).toHaveAttribute("target", "_blank");
	await expect(bookingLink).toHaveAttribute("rel", "noopener noreferrer");
	await expect(bookingLink).toHaveCSS("color", primaryTextColor);
	await bookingLink.dispatchEvent("auxclick", { button: 1 });
	await expect(dialog).toBeHidden();
	await expect.poll(() => actions.at(-1)).toBe("book");

	sendInvitation(browserSocket);
	await expect(dialog).toBeVisible();
	const bookingPopupPromise = page.waitForEvent("popup");
	await bookingLink.click();
	const bookingPopup = await bookingPopupPromise;
	await bookingPopup.close();
	await expect(dialog).toBeHidden();
	await expect.poll(() => actions.at(-1)).toBe("book");
});
