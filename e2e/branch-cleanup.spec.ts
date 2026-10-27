import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { BRANCH_CLEANUP_PROTOCOL_VERSION, WS_CHANNELS } from "@thinkrail/contracts";
import {
	createWorkspaceViaDialog,
	openFixtureProject,
	openWorkspaceMenu,
	PHONE_VIEWPORT,
	worktreeRows,
} from "./fixtures/app";
import { commitFile, git, gitAs, gitText } from "./fixtures/git";
import { E2E_FIXTURE_REPO } from "./fixtures/paths";
import { E2eWire } from "./fixtures/wire";

async function openManager(page: Page) {
	await page.getByTestId("project-menu").first().click();
	await page.getByTestId("project-menu-manage-branches").click();
	await expect(page.getByTestId("local-branches-dialog")).toBeVisible();
}

function branchRow(page: Page, branch: string) {
	return page.locator(`[data-testid="branch-cleanup-row"][data-branch="${branch}"]`);
}

function newCommit(parent = "HEAD") {
	return gitAs(
		E2E_FIXTURE_REPO,
		"commit-tree",
		"HEAD^{tree}",
		"-p",
		parent,
		"-m",
		"isolated cleanup fixture",
	);
}

test("a forged case alias cannot bypass host protection of the default/current branch", async ({
	page,
}) => {
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.method === "git.deleteBranch") {
				frame.params.name = "MAIN";
				frame.params.allowUnmerged = true;
				frame.params.confirmName = "MAIN";
				server.send(JSON.stringify(frame));
			} else server.send(message);
		});
	});
	await openFixtureProject(page);
	git(E2E_FIXTURE_REPO, "branch", "cleanup-case-spoof", "main");
	await openManager(page);
	await branchRow(page, "cleanup-case-spoof")
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await page.getByTestId("confirm-delete-branch").click();
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(page.getByTestId("local-branches-dialog")).toBeVisible();
	expect(gitText(E2E_FIXTURE_REPO, "show-ref", "--verify", "refs/heads/main")).toContain(
		"refs/heads/main",
	);
	expect(gitText(E2E_FIXTURE_REPO, "branch", "--list", "cleanup-case-spoof")).toContain(
		"cleanup-case-spoof",
	);
});

test("local branch manager protects occupied/default branches, cancels safely and refreshes after deletion", async ({
	page,
}) => {
	await openFixtureProject(page);
	git(E2E_FIXTURE_REPO, "branch", "cleanup-merged", "main");
	await openManager(page);
	await expect(
		branchRow(page, "main").getByRole("button", { name: "Delete", exact: true }),
	).toBeDisabled();
	await branchRow(page, "cleanup-merged")
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await expect(page.getByTestId("confirm-delete-branch")).toBeEnabled();
	await expect(page.getByTestId("branch-delete-name")).toHaveCount(0);
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(gitText(E2E_FIXTURE_REPO, "branch", "--list", "cleanup-merged")).toContain(
		"cleanup-merged",
	);
	await branchRow(page, "cleanup-merged")
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await page.getByTestId("confirm-delete-branch").click();
	await expect(branchRow(page, "cleanup-merged")).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Search local branches" })).toBeFocused();
	expect(gitText(E2E_FIXTURE_REPO, "branch", "--list", "cleanup-merged").trim()).toBe("");
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("project-name").first()).toBeFocused();
});

test("unmerged deletion requires exact text and rejects a changed preview until refreshed", async ({
	page,
}) => {
	await openFixtureProject(page);
	const name = "cleanup-unmerged";
	git(E2E_FIXTURE_REPO, "branch", name, newCommit());
	await openManager(page);
	await branchRow(page, name).getByRole("button", { name: "Delete", exact: true }).click();
	const confirm = page.getByTestId("confirm-delete-branch");
	await expect(confirm).toBeDisabled();
	await page.getByTestId("branch-delete-name").fill(`${name} `);
	await expect(confirm).toBeDisabled();
	await page.getByTestId("branch-delete-name").fill(name);
	git(E2E_FIXTURE_REPO, "update-ref", `refs/heads/${name}`, newCommit(name));
	await confirm.click();
	await expect(page.getByRole("alert")).toContainText("changed");
	await expect(page.getByTestId("local-branches-dialog")).toBeVisible();
	expect(gitText(E2E_FIXTURE_REPO, "branch", "--list", name)).toContain(name);
	await page.getByRole("button", { name: "Refresh branches", exact: true }).click();
	await expect(page.getByTestId("branch-delete-name")).toHaveCount(0);
	await branchRow(page, name).getByRole("button", { name: "Delete", exact: true }).click();
	await page.getByTestId("branch-delete-name").fill(name);
	await confirm.click();
	await expect(branchRow(page, name)).toHaveCount(0);
});

test("workspace removal keeps its branch by default and preserves dirty worktrees on failure", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const path = join(workspace.worktreePath, "keep-untracked.txt");
	writeFileSync(path, "must survive\n");
	await openWorkspaceMenu(worktreeRows(page).first());
	await page.getByTestId("workspace-remove").click();
	await expect(page.getByTestId("remove-delete-branch")).not.toBeChecked();
	await page.getByTestId("confirm-remove").click();
	await expect(page.getByRole("alert")).toContainText("Uncommitted");
	await expect(page.getByTestId("confirm-dialog")).toBeVisible();
	expect(existsSync(path)).toBe(true);
	await expect(worktreeRows(page)).toHaveCount(1);
	rmSync(path);
	await page.getByTestId("confirm-remove").click();
	await expect(worktreeRows(page)).toHaveCount(0);
	await expect(page.getByTestId("project-name").first()).toBeFocused();
	expect(existsSync(workspace.worktreePath)).toBe(false);
	expect(gitText(E2E_FIXTURE_REPO, "branch", "--list", workspace.branch)).toContain(
		workspace.branch,
	);
});

test("optional branch failure reports partial completion after real worktree reclamation", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	await openWorkspaceMenu(worktreeRows(page).first());
	await page.getByTestId("workspace-remove").click();
	await expect(page.getByTestId("remove-delete-branch")).toBeEnabled();
	await page.getByTestId("remove-delete-branch").check();
	const lock = join(E2E_FIXTURE_REPO, ".git", "refs", "heads", `${workspace.branch}.lock`);
	writeFileSync(lock, "isolated lock fixture\n");
	try {
		await page.getByTestId("confirm-remove").click();
		await expect(worktreeRows(page)).toHaveCount(0, { timeout: 20_000 });
		await expect(
			page
				.getByTestId("shell")
				.getByText(`The worktree was removed, but local branch ${workspace.branch} is retained.`),
		).toBeVisible();
		expect(existsSync(workspace.worktreePath)).toBe(false);
		expect(gitText(E2E_FIXTURE_REPO, "branch", "--list", workspace.branch)).toContain(
			workspace.branch,
		);
	} finally {
		rmSync(lock, { force: true });
	}
});

test("Chinese mobile dialogs wrap risk text, keep keyboard focus, and delete only after exact confirmation", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	const wire = await E2eWire.connect(Number(new URL(page.url()).port));
	try {
		await wire.request("settings.update", { config: { locale: "zh-CN" } });
		await page.setViewportSize(PHONE_VIEWPORT);
		await page.getByTestId("scope-workspace").click();
		await page.getByTestId("scope-workspace-remove").click();
		const removal = page.getByTestId("confirm-dialog");
		await expect(removal).toContainText("保留分支不等于保留文件");
		await expect(page.getByTestId("remove-delete-branch")).not.toBeChecked();
		await expect(page.getByTestId("remove-delete-branch")).toBeEnabled();
		await removal.screenshot({ path: ".github/readme-assets/remove-workspace-zh.png" });
		await page.getByRole("button", { name: "取消", exact: true }).click();
		await page.getByTestId("project-name").first().focus();
		await page.getByTestId("project-name").first().press("Enter");
		await page.setViewportSize({ width: 1000, height: 800 });
		await page.getByTestId("project-menu").first().click();
		const menu = page.getByTestId("project-actions");
		await expect(menu.getByTestId("project-menu-manage-branches")).toHaveText("管理本地分支");
		const rowBox = await page.getByTestId("project-item").first().boundingBox();
		const menuBox = await menu.boundingBox();
		if (!rowBox || !menuBox) throw new Error("Project menu has no visible bounds");
		const x = Math.min(rowBox.x, menuBox.x);
		const y = Math.min(rowBox.y, menuBox.y);
		await page.screenshot({
			path: ".github/readme-assets/project-menu-zh.png",
			clip: {
				x,
				y,
				width: Math.max(rowBox.x + rowBox.width, menuBox.x + menuBox.width) - x,
				height: Math.max(rowBox.y + rowBox.height, menuBox.y + menuBox.height) - y,
			},
		});
		await page.keyboard.press("Escape");
		await page.setViewportSize(PHONE_VIEWPORT);
		await openManager(page);
		await expect(
			branchRow(page, workspace.branch).getByRole("button", { name: "删除", exact: true }),
		).toBeDisabled();
		git(E2E_FIXTURE_REPO, "branch", "清理-隔离分支-用于验证手机换行", newCommit());
		await page.getByRole("button", { name: "刷新分支", exact: true }).click();
		const name = "清理-隔离分支-用于验证手机换行";
		await branchRow(page, name).getByRole("button", { name: "删除", exact: true }).click();
		await page.getByTestId("branch-delete-name").focus();
		await expect(page.getByTestId("branch-delete-name")).toBeFocused();
		const dialog = page.getByTestId("local-branches-dialog");
		await expect(dialog).toContainText("未合并提交可能丢失");
		expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
			true,
		);
		const bounds = await dialog.boundingBox();
		expect(bounds && bounds.y >= 0 && bounds.y + bounds.height <= PHONE_VIEWPORT.height).toBe(true);
		await dialog.screenshot({ path: ".github/readme-assets/branches-zh.png" });
		await page.getByTestId("branch-delete-name").fill(name);
		await page.getByTestId("confirm-delete-branch").focus();
		await page.keyboard.press("Enter");
		await expect(branchRow(page, name)).toHaveCount(0);
	} finally {
		await wire.request("settings.update", { config: { locale: "en" } });
		wire.close();
	}
});

test("old hosts hide branch cleanup and receive no new workspace removal parameters", async ({
	page,
}) => {
	const frames: { method?: string; params?: Record<string, unknown> }[] = [];
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			frames.push(JSON.parse(String(message)));
			server.send(message);
		});
		server.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.channel === WS_CHANNELS.serverWelcome) {
				frame.data.protocolVersion = BRANCH_CLEANUP_PROTOCOL_VERSION - 1;
				socket.send(JSON.stringify(frame));
			} else socket.send(message);
		});
	});
	await openFixtureProject(page);
	await createWorkspaceViaDialog(page);
	await page.getByTestId("project-name").first().click({ button: "right" });
	await expect(page.getByTestId("project-menu-manage-branches")).toHaveCount(0);
	await page.keyboard.press("Escape");
	await openWorkspaceMenu(worktreeRows(page).first());
	await page.getByTestId("workspace-remove").click();
	await expect(page.getByTestId("remove-delete-branch")).toHaveCount(0);
	await page.getByTestId("confirm-remove").click();
	await expect(worktreeRows(page)).toHaveCount(0);
	expect(
		frames
			.filter((frame) => frame.method === "workspace.remove")
			.every((frame) => !Object.hasOwn(frame.params ?? {}, "deleteBranch")),
	).toBe(true);
	expect(
		frames.some((frame) =>
			["git.listBranchesForCleanup", "git.deleteBranch"].includes(frame.method ?? ""),
		),
	).toBe(false);
});

test("pending deletion is single-flight and does not optimistically hide the branch", async ({
	page,
}) => {
	let deleteId: string | undefined;
	let deletes = 0;
	let release: () => void = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.routeWebSocket(/\/ws(\?|$)/, (socket) => {
		const server = socket.connectToServer();
		socket.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.method === "git.deleteBranch") {
				deleteId = frame.id;
				deletes += 1;
			}
			server.send(message);
		});
		server.onMessage((message) => {
			if (JSON.parse(String(message)).id === deleteId && deleteId)
				void released.then(() => socket.send(message));
			else socket.send(message);
		});
	});
	await openFixtureProject(page);
	git(E2E_FIXTURE_REPO, "branch", "cleanup-pending", "main");
	await openManager(page);
	await branchRow(page, "cleanup-pending")
		.getByRole("button", { name: "Delete", exact: true })
		.click();
	await page.getByTestId("confirm-delete-branch").click();
	await expect(page.getByTestId("confirm-delete-branch")).toBeDisabled();
	await page
		.getByTestId("confirm-delete-branch")
		.evaluate((button: HTMLButtonElement) => button.click());
	await expect(branchRow(page, "cleanup-pending")).toBeVisible();
	await expect(page.getByRole("button", { name: "Refresh branches", exact: true })).toBeDisabled();
	expect(deletes).toBe(1);
	release();
	await expect(branchRow(page, "cleanup-pending")).toHaveCount(0);
	await expect(page.getByRole("textbox", { name: "Search local branches" })).toBeFocused();
});

test("workspace removal with an unmerged branch requires complete-name confirmation", async ({
	page,
}) => {
	await openFixtureProject(page);
	const workspace = await createWorkspaceViaDialog(page);
	commitFile(
		workspace.worktreePath,
		"unmerged.txt",
		"isolated commit\n",
		"isolated unmerged workspace",
	);
	await openWorkspaceMenu(worktreeRows(page).first());
	await page.getByTestId("workspace-remove").click();
	await expect(page.getByTestId("remove-delete-branch")).toBeEnabled();
	await page.getByTestId("remove-delete-branch").check();
	await expect(page.getByTestId("branch-delete-name")).toBeFocused();
	await expect(page.getByTestId("confirm-remove")).toBeDisabled();
	await page.getByTestId("branch-delete-name").fill(workspace.branch);
	await page.getByTestId("confirm-remove").click();
	await expect(worktreeRows(page)).toHaveCount(0);
	expect(existsSync(workspace.worktreePath)).toBe(false);
	expect(gitText(E2E_FIXTURE_REPO, "branch", "--list", workspace.branch).trim()).toBe("");
});
