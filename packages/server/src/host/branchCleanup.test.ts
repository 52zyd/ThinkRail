import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BranchDeleteInput, Workspace } from "@thinkrail/contracts";
import { BRANCH_CLEANUP_PROTOCOL_VERSION } from "@thinkrail/contracts";
import * as agent from "../agent";
import * as gitModule from "../git";
import { defaultSessionDirFor, writeFixtureSession } from "../history/testFixtures";
import { saveProjects, saveWorkspaces } from "../persistence";
import { resetConfigCache } from "../settings";
import { stopAllWatches } from "../watch";
import {
	assertWorktreeRemovable,
	createWorkspace,
	getWorkspace,
	listAllWorkspaceRecords,
	openExistingWorktree,
	setWorkspaceDiffBase,
} from "../workspaces";
import { branchCleanupList, deleteBranch, removeWorkspaceSafely } from "./branchCleanup";
import { handleRequest } from "./handlers";

const saved = {
	THINKRAIL_DATA_DIR: process.env.THINKRAIL_DATA_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	PI_OFFLINE: process.env.PI_OFFLINE,
};
const tempRoot = realpathSync.native(tmpdir());
let directory: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (!result.success) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

async function deletion(name: string): Promise<BranchDeleteInput> {
	const catalog = await branchCleanupList("p1");
	const branch = catalog.branches.find((entry) => entry.name === name);
	if (!branch) throw new Error(`Missing branch ${name}`);
	return {
		projectId: "p1",
		name,
		oid: branch.oid,
		baseRef: catalog.baseRef,
		baseOid: catalog.baseOid,
	};
}

function commit(cwd: string, name = "change.txt"): void {
	writeFileSync(join(cwd, name), "change\n");
	git(cwd, "add", "--", name);
	git(cwd, "commit", "-m", "change");
}

function branchExists(name: string): boolean {
	return gitModule.git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${name}`]).ok;
}

beforeEach(() => {
	directory = realpathSync.native(mkdtempSync(join(tempRoot, "thinkrail-cleanup-")));
	process.env.THINKRAIL_DATA_DIR = directory;
	process.env.PI_CODING_AGENT_DIR = join(directory, "pi");
	process.env.PI_OFFLINE = "1";
	repo = join(directory, "repo");
	mkdirSync(repo);
	git(repo, "init", "-b", "main");
	git(repo, "config", "user.email", "test@thinkrail.test");
	git(repo, "config", "user.name", "test");
	git(repo, "config", "commit.gpgsign", "false");
	writeFileSync(join(repo, "README.md"), "original\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "initial");
	saveProjects([{ id: "p1", path: repo, name: "test", slug: "test", lastOpened: 1 }]);
	resetConfigCache();
});

afterEach(() => {
	mock.restore();
	stopAllWatches();
	resetConfigCache();
	if (dirname(directory) !== tempRoot || !directory.includes("thinkrail-cleanup-"))
		throw new Error("Unsafe fixture cleanup path");
	rmSync(directory, { recursive: true, force: true });
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

test("merged, unused branches use non-force Git deletion", async () => {
	git(repo, "branch", "feature/merged");
	const input = await deletion("feature/merged");
	expect(await deleteBranch(input)).toEqual({ ok: true });
	expect(branchExists(input.name)).toBe(false);
});

test("a non-catalog case alias cannot bypass protection of the default/current branch", async () => {
	const input = await deletion("main");
	await expect(
		deleteBranch({ ...input, name: "MAIN", allowUnmerged: true, confirmName: "MAIN" }),
	).rejects.toThrow();
	expect(branchExists("main")).toBe(true);
	expect(git(repo, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
});

test("a literal namespace-like branch name is not confused with the default branch", async () => {
	git(repo, "branch", "heads/main");
	await deleteBranch(await deletion("heads/main"));
	expect(branchExists("heads/main")).toBe(false);
	expect(branchExists("main")).toBe(true);
});

test.skipIf(process.platform !== "win32")(
	"a worktree HEAD case alias still protects the exact catalog branch",
	async () => {
		const path = join(directory, "case-worktree");
		git(repo, "worktree", "add", "-b", "feature/case", "--", path);
		git(path, "symbolic-ref", "HEAD", "refs/heads/FEATURE/CASE");
		expect(git(path, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "feature/case"));
		const branch = (await branchCleanupList("p1")).branches.find(
			(row) => row.name === "feature/case",
		);
		expect(branch?.blockedReason).toBe("worktree");
		await expect(deleteBranch(await deletion("feature/case"))).rejects.toThrow(
			"used by a worktree",
		);
		expect(branchExists("feature/case")).toBe(true);
	},
);

test.skipIf(process.platform !== "win32")(
	"workspace comparison references protect heads/ case aliases",
	async () => {
		git(repo, "branch", "feature/reference");
		const ws = await createWorkspace("p1");
		setWorkspaceDiffBase(ws.id, "heads/FEATURE/REFERENCE");
		expect(git(repo, "rev-parse", "heads/FEATURE/REFERENCE")).toBe(
			git(repo, "rev-parse", "feature/reference"),
		);
		await expect(deleteBranch(await deletion("feature/reference"))).rejects.toThrow("referenced");
		expect(branchExists("feature/reference")).toBe(true);
	},
);

test.skipIf(process.platform !== "win32")(
	"an aliased default target fails closed instead of guessing its branch",
	async () => {
		git(repo, "symbolic-ref", "HEAD", "refs/heads/MAIN");
		await expect(branchCleanupList("p1")).rejects.toThrow("not an exact Git ref");
		expect(branchExists("main")).toBe(true);
	},
);

test("unmerged deletion requires both explicit risk permission and the exact name", async () => {
	git(repo, "switch", "-c", "feature/unmerged");
	commit(repo);
	git(repo, "switch", "main");
	const input = await deletion("feature/unmerged");
	expect(
		(await branchCleanupList("p1")).branches.find((branch) => branch.name === input.name)
			?.unmergedCommits,
	).toBe(1);
	for (const confirmation of [
		{},
		{ confirmName: input.name },
		{ allowUnmerged: true },
		{ allowUnmerged: true, confirmName: "unmerged" },
	]) {
		await expect(deleteBranch({ ...input, ...confirmation })).rejects.toThrow(
			"Type the complete branch name",
		);
		expect(branchExists(input.name)).toBe(true);
	}
	await deleteBranch({ ...input, allowUnmerged: true, confirmName: input.name });
	expect(branchExists(input.name)).toBe(false);
});

test.each([
	"branch",
	"base",
	"default",
])("a changed %s identity invalidates the preview", async (changed) => {
	git(repo, "branch", "feature/stale");
	const input = await deletion("feature/stale");
	if (changed === "branch") {
		git(repo, "switch", "feature/stale");
		commit(repo);
		git(repo, "switch", "main");
	} else if (changed === "base") commit(repo);
	else git(repo, "switch", "-c", "new-default");
	await expect(deleteBranch(input)).rejects.toThrow("changed");
	expect(branchExists(input.name)).toBe(true);
});

test("the actual fully-qualified remote default cannot be replaced by a local decoy", async () => {
	const base = git(repo, "rev-parse", "HEAD");
	git(repo, "remote", "add", "origin", repo);
	git(repo, "update-ref", "refs/remotes/origin/main", base);
	git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
	git(repo, "switch", "-c", "origin/main");
	commit(repo);
	git(repo, "switch", "main");
	const catalog = await branchCleanupList("p1");
	expect(catalog.baseRef).toBe("refs/remotes/origin/main");
	expect(catalog.baseOid).toBe(base);
	expect(catalog.branches.find((branch) => branch.name === "main")?.blockedReason).toBe("default");
	expect(catalog.branches.find((branch) => branch.name === "origin/main")?.unmergedCommits).toBe(1);
	await expect(deleteBranch(await deletion("main"))).rejects.toThrow("default branch");
});

test.each(["origin", "upstream"])("a dangling %s remote default fails closed", async (remote) => {
	git(repo, "remote", "add", remote, repo);
	git(repo, "symbolic-ref", `refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/missing`);
	await expect(branchCleanupList("p1")).rejects.toThrow();
});

test("all worktree registrations, including missing worktrees, protect their branch", async () => {
	const path = join(directory, "occupied");
	git(repo, "worktree", "add", "-b", "feature/occupied", "--", path);
	rmSync(path, { recursive: true, force: true });
	const branch = (await branchCleanupList("p1")).branches.find(
		(row) => row.name === "feature/occupied",
	);
	expect(branch?.blockedReason).toBe("worktree");
	expect(branch?.worktreePaths).toEqual([path]);
	await expect(deleteBranch(await deletion("feature/occupied"))).rejects.toThrow(
		"used by a worktree",
	);
});

test.each([
	"baseBranch",
	"diffBase",
] as const)("%s on another workspace in the same repository protects a branch", async (field) => {
	git(repo, "branch", "feature/reference");
	const ws = await createWorkspace("p1");
	saveProjects([
		{ id: "p1", path: repo, name: "test", slug: "test", lastOpened: 1 },
		{ id: "p2", path: ws.worktreePath, name: "alias", slug: "alias", lastOpened: 1 },
	]);
	saveWorkspaces([{ ...ws, projectId: "p2", [field]: "refs/heads/feature/reference" }]);
	const branch = (await branchCleanupList("p1")).branches.find(
		(row) => row.name === "feature/reference",
	);
	expect(branch?.workspaceIds).toEqual([ws.id]);
	expect(branch?.workspaceNames).toEqual([ws.name]);
	await expect(deleteBranch(await deletion("feature/reference"))).rejects.toThrow(
		"referenced by another workspace",
	);
});

test("closed projects retain workspace protection without blocking unrelated cleanup", async () => {
	git(repo, "branch", "feature/retained");
	git(repo, "branch", "feature/disposable");
	const ws = await createWorkspace("p1");
	saveProjects([
		{ id: "p1", path: repo, name: "test", slug: "test", lastOpened: 1 },
		{
			id: "p2",
			path: ws.worktreePath,
			name: "closed alias",
			slug: "closed-alias",
			lastOpened: 1,
			closed: true,
		},
	]);
	saveWorkspaces([{ ...ws, projectId: "p2", diffBase: "feature/retained" }]);
	const catalog = await branchCleanupList("p1");
	expect(catalog.branches.find((row) => row.name === "feature/retained")?.blockedReason).toBe(
		"workspace",
	);
	await expect(deleteBranch(await deletion("feature/retained"))).rejects.toThrow(
		"referenced by another workspace",
	);
	await deleteBranch(await deletion("feature/disposable"));
	expect(branchExists("feature/retained")).toBe(true);
	expect(branchExists("feature/disposable")).toBe(false);
});

test("unreadable workspace records and unavailable repository facts never become an empty catalog", async () => {
	git(repo, "branch", "feature/safe");
	const input = await deletion("feature/safe");
	writeFileSync(join(directory, "workspaces.json"), "{invalid");
	await expect(deleteBranch(input)).rejects.toThrow();
	expect(branchExists(input.name)).toBe(true);
	const ws = await createWorkspace("p1");
	saveWorkspaces([{ ...ws, projectId: "unknown-project" }]);
	await expect(deleteBranch(input)).rejects.toThrow("workspace has no project");
	expect(branchExists(input.name)).toBe(true);
	saveWorkspaces([]);
	saveProjects([
		{ id: "p1", path: repo, name: "test", slug: "test", lastOpened: 1 },
		{ id: "p2", path: join(directory, "missing"), name: "unknown", slug: "unknown", lastOpened: 1 },
	]);
	await expect(branchCleanupList("p1")).rejects.toThrow("Could not read repository");
});

test.each([
	undefined,
	BRANCH_CLEANUP_PROTOCOL_VERSION - 1,
])("pre-cleanup protocol %s cannot send cleanup methods or removal options", async (version) => {
	const ctx = {
		clientKey: "old-client",
		...(version === undefined ? {} : { protocolVersion: version }),
	};
	await expect(
		handleRequest("git.listBranchesForCleanup", { projectId: "p1" }, ctx),
	).rejects.toThrow("requires a newer");
	await expect(handleRequest("git.deleteBranch", {}, ctx)).rejects.toThrow("requires a newer");
	await expect(
		handleRequest("workspace.remove", { id: "missing", deleteBranch: {} }, ctx),
	).rejects.toThrow("requires a newer");
	expect(await handleRequest("workspace.remove", { id: "missing" }, ctx)).toEqual({ ok: true });
});

test.each([
	"unstaged",
	"staged",
	"untracked",
])("%s changes block managed removal without losing files or records", async (kind) => {
	const ws = await createWorkspace("p1");
	const path = join(ws.worktreePath, kind === "untracked" ? "new.txt" : "README.md");
	writeFileSync(path, "keep me\n");
	if (kind === "staged") git(ws.worktreePath, "add", "--", "README.md");
	await expect(removeWorkspaceSafely({ id: ws.id })).rejects.toThrow("uncommitted changes");
	expect(readFileSync(path, "utf8")).toBe("keep me\n");
	expect(getWorkspace(ws.id).id).toBe(ws.id);
});

test("ignored generated files are reclaimed without a force flag", async () => {
	const ws = await createWorkspace("p1");
	writeFileSync(join(repo, ".git", "info", "exclude"), "ignored.txt\n");
	writeFileSync(join(ws.worktreePath, "ignored.txt"), "ignored\n");
	expect(() => assertWorktreeRemovable(ws)).not.toThrow();
	expect(await removeWorkspaceSafely({ id: ws.id })).toEqual({ ok: true });
	expect(existsSync(ws.worktreePath)).toBe(false);
});

test("reclaim failure preserves workspace membership, branch and chat history", async () => {
	const ws = await createWorkspace("p1");
	const history = writeFixtureSession(
		defaultSessionDirFor(join(directory, "pi"), ws.worktreePath),
		{ cwd: ws.worktreePath, messages: [{ role: "user", text: "keep history", timestamp: 1 }] },
	);
	const original = gitModule.git;
	spyOn(gitModule, "git").mockImplementation((cwd, args, opts) =>
		args[0] === "worktree" && args[1] === "remove"
			? { ok: false, out: "", err: "locked by test" }
			: original(cwd, args, opts),
	);
	await expect(removeWorkspaceSafely({ id: ws.id })).rejects.toThrow("locked by test");
	expect(existsSync(history.path)).toBe(true);
	expect(existsSync(ws.worktreePath)).toBe(true);
	expect(getWorkspace(ws.id).id).toBe(ws.id);
	expect(branchExists(ws.branch)).toBe(true);
});

test("post-close dirty files are rechecked before reclamation", async () => {
	const ws = await createWorkspace("p1");
	spyOn(agent, "withWorkspaceSessionsClosed").mockImplementation(async (_id, operation) => {
		writeFileSync(join(ws.worktreePath, "README.md"), "late change\n");
		return operation();
	});
	await expect(removeWorkspaceSafely({ id: ws.id })).rejects.toThrow("uncommitted changes");
	expect(getWorkspace(ws.id).id).toBe(ws.id);
	expect(readFileSync(join(ws.worktreePath, "README.md"), "utf8")).toBe("late change\n");
});

test("missing managed directories unregister only their own worktree and return the true result", async () => {
	const ws = await createWorkspace("p1");
	const other = join(directory, "missing-other");
	git(repo, "worktree", "add", "-b", "other", "--", other);
	rmSync(ws.worktreePath, { recursive: true, force: true });
	rmSync(other, { recursive: true, force: true });
	expect(await removeWorkspaceSafely({ id: ws.id })).toEqual({ ok: true });
	expect(branchExists(ws.branch)).toBe(true);
	expect(git(repo, "worktree", "list", "--porcelain")).toContain(other.replaceAll("\\", "/"));
	expect(listAllWorkspaceRecords().some((row) => row.id === ws.id)).toBe(false);
});

test.each([
	false,
	true,
])("an already unregistered managed checkout finishes cleanup on retry (delete branch: %s)", async (deleteBranch) => {
	const ws = await createWorkspace("p1");
	const input = await deletion(ws.branch);
	const history = writeFixtureSession(
		defaultSessionDirFor(join(directory, "pi"), ws.worktreePath),
		{ cwd: ws.worktreePath, messages: [{ role: "user", text: "retry cleanup", timestamp: 1 }] },
	);
	git(repo, "worktree", "remove", "--", ws.worktreePath);
	const result = await removeWorkspaceSafely({
		id: ws.id,
		...(deleteBranch ? { deleteBranch: input } : {}),
	});
	expect(result).toEqual({ ok: true, ...(deleteBranch ? { branchDeleted: true } : {}) });
	expect(existsSync(history.path)).toBe(false);
	expect(branchExists(ws.branch)).toBe(!deleteBranch);
	expect(listAllWorkspaceRecords().some((row) => row.id === ws.id)).toBe(false);
});

test("a missing checkout with an unreadable registry keeps its record for retry", async () => {
	const ws = await createWorkspace("p1");
	git(repo, "worktree", "remove", "--", ws.worktreePath);
	spyOn(gitModule, "listGitWorktreesSync").mockImplementation(() => {
		throw new Error("registry unavailable");
	});
	await expect(removeWorkspaceSafely({ id: ws.id })).rejects.toThrow("registry unavailable");
	expect(getWorkspace(ws.id).id).toBe(ws.id);
	expect(branchExists(ws.branch)).toBe(true);
});

test("cleanup transactions in one repository do not overlap while session disposal waits", async () => {
	const first = await createWorkspace("p1");
	const second = await createWorkspace("p1");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const close = spyOn(agent, "withWorkspaceSessionsClosed").mockImplementation(
		async (id, operation) => {
			if (id === first.id) {
				entered.resolve();
				await release.promise;
			}
			return operation();
		},
	);
	const removingFirst = removeWorkspaceSafely({ id: first.id });
	const removingSecond = removeWorkspaceSafely({ id: second.id });
	await entered.promise;
	expect(close).toHaveBeenCalledTimes(1);
	expect(existsSync(second.worktreePath)).toBe(true);
	release.resolve();
	await Promise.all([removingFirst, removingSecond]);
	expect(close).toHaveBeenCalledTimes(2);
});

test("successful reclaim optionally deletes its own merged branch only", async () => {
	const ws = await createWorkspace("p1");
	const input = await deletion(ws.branch);
	expect(await removeWorkspaceSafely({ id: ws.id, deleteBranch: input })).toEqual({
		ok: true,
		branchDeleted: true,
	});
	expect(existsSync(ws.worktreePath)).toBe(false);
	expect(branchExists(ws.branch)).toBe(false);
	expect(listAllWorkspaceRecords().some((row) => row.id === ws.id)).toBe(false);
});

test("duplicate cleanup cannot report an unperformed optional branch deletion", async () => {
	const ws = await createWorkspace("p1");
	const input = { id: ws.id, deleteBranch: await deletion(ws.branch) };
	const results = await Promise.allSettled([
		removeWorkspaceSafely({ id: ws.id }),
		removeWorkspaceSafely(input),
	]);
	expect(results[0]).toEqual({ status: "fulfilled", value: { ok: true } });
	expect(results[1]?.status).toBe("rejected");
	await expect(removeWorkspaceSafely(input)).rejects.toThrow("already removed");
	expect(await removeWorkspaceSafely({ id: ws.id })).toEqual({ ok: true });
	expect(branchExists(ws.branch)).toBe(true);
});

test("concurrent duplicate branch deletions perform only one mutation", async () => {
	git(repo, "branch", "feature/duplicate");
	const input = await deletion("feature/duplicate");
	const results = await Promise.allSettled([deleteBranch(input), deleteBranch(input)]);
	expect(results[0]).toEqual({ status: "fulfilled", value: { ok: true } });
	expect(results[1]?.status).toBe("rejected");
	expect(branchExists(input.name)).toBe(false);
});

test("another workspace comparison target blocks optional deletion before reclaim", async () => {
	const ws = await createWorkspace("p1");
	const other = await createWorkspace("p1");
	setWorkspaceDiffBase(other.id, ws.branch);
	await expect(
		removeWorkspaceSafely({ id: ws.id, deleteBranch: await deletion(ws.branch) }),
	).rejects.toThrow("referenced by another workspace");
	expect(existsSync(ws.worktreePath)).toBe(true);
	expect(getWorkspace(ws.id).id).toBe(ws.id);
});

test("non-force upstream refusal returns an explicit retained branch after successful reclamation", async () => {
	const ws = await createWorkspace("p1");
	git(repo, "branch", "upstream-behind");
	git(ws.worktreePath, "branch", "--set-upstream-to=upstream-behind");
	commit(ws.worktreePath);
	git(repo, "merge", "--ff-only", ws.branch);
	const input = await deletion(ws.branch);
	expect(
		(await branchCleanupList("p1")).branches.find((row) => row.name === ws.branch)?.unmergedCommits,
	).toBe(0);
	const result = await removeWorkspaceSafely({ id: ws.id, deleteBranch: input });
	expect(result).toMatchObject({ ok: true, branchDeleted: false, retainedBranch: ws.branch });
	expect(result.cleanupError).toContain("Could not delete branch");
	expect(branchExists(ws.branch)).toBe(true);
	expect(existsSync(ws.worktreePath)).toBe(false);
	expect(listAllWorkspaceRecords().some((row) => row.id === ws.id)).toBe(false);
});

test("external workspaces unlink even when dirty, and cannot delete their branch", async () => {
	const path = join(directory, "external");
	git(repo, "worktree", "add", "-b", "external", "--", path);
	const ws = await openExistingWorktree("p1", path);
	writeFileSync(join(path, "private.txt"), "keep\n");
	await expect(
		removeWorkspaceSafely({ id: ws.id, deleteBranch: await deletion("external") }),
	).rejects.toThrow("external workspace");
	expect(await removeWorkspaceSafely({ id: ws.id })).toEqual({ ok: true });
	expect(readFileSync(join(path, "private.txt"), "utf8")).toBe("keep\n");
	expect(branchExists("external")).toBe(true);
	expect(git(repo, "worktree", "list", "--porcelain")).toContain(path.replaceAll("\\", "/"));
});

test("unsafe managed paths and replaced Git identities reject before deleting anything", async () => {
	const ws = await createWorkspace("p1");
	for (const path of [repo, directory, join(directory, "outside")]) {
		const corrupt: Workspace = { ...ws, worktreePath: path };
		expect(() => assertWorktreeRemovable(corrupt)).toThrow("outside application-managed storage");
	}
	const other = join(directory, "other");
	mkdirSync(other);
	git(other, "init", "-b", "main");
	writeFileSync(join(ws.worktreePath, ".git"), `gitdir: ${join(other, ".git")}\n`);
	expect(() => assertWorktreeRemovable(ws)).toThrow("no longer belongs");
	expect(existsSync(join(repo, "README.md"))).toBe(true);
});

test("a managed checkout opened as another project root cannot be reclaimed", async () => {
	const ws = await createWorkspace("p1");
	saveProjects([
		{ id: "p1", path: repo, name: "test", slug: "test", lastOpened: 1 },
		{ id: "p2", path: ws.worktreePath, name: "nested", slug: "nested", lastOpened: 1 },
	]);
	await expect(removeWorkspaceSafely({ id: ws.id })).rejects.toThrow(
		"outside application-managed storage",
	);
	expect(existsSync(ws.worktreePath)).toBe(true);
	expect(getWorkspace(ws.id).id).toBe(ws.id);
	expect(branchExists(ws.branch)).toBe(true);
});

test("a symbolic-link path component cannot redirect managed cleanup", async () => {
	const ws = await createWorkspace("p1");
	const alias = join(directory, "worktrees", "alias");
	symlinkSync(dirname(ws.worktreePath), alias, process.platform === "win32" ? "junction" : "dir");
	expect(() => assertWorktreeRemovable({ ...ws, worktreePath: join(alias, ws.branch) })).toThrow(
		"symbolic link",
	);
	expect(existsSync(ws.worktreePath)).toBe(true);
});
