import { resolve } from "node:path";
import type {
	BranchCleanupEntry,
	BranchCleanupList,
	BranchDeleteInput,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { loadProjects } from "../persistence";
import { canonicalPath } from "./git";
import { git, gitAsync } from "./gitExec";
import { assertSafeRef, refersToLocalBranch, remoteNameOf } from "./refs";

export interface GitWorktreeEntry {
	path: string;
	branch?: string;
	prunable: boolean;
}

function parseWorktrees(output: string): GitWorktreeEntry[] {
	if (!output)
		throw new CodedError("BRANCH_CLEANUP_READ_FAILED", "Git returned no worktree registry");
	return output
		.split("\0\0")
		.filter(Boolean)
		.map((record) => {
			const fields = record.split("\0");
			const path = fields.find((field) => field.startsWith("worktree "))?.slice(9);
			if (!path)
				throw new CodedError("BRANCH_CLEANUP_READ_FAILED", "Invalid Git worktree registry");
			const branch = fields.find((field) => field.startsWith("branch refs/heads/"))?.slice(18);
			return {
				path: resolve(path),
				prunable: fields.some((field) => field === "prunable" || field.startsWith("prunable ")),
				...(branch ? { branch } : {}),
			};
		});
}

export async function listGitWorktrees(repoPath: string): Promise<GitWorktreeEntry[]> {
	const result = await gitAsync(repoPath, ["worktree", "list", "--porcelain", "-z"], { raw: true });
	if (!result.ok)
		throw new CodedError("BRANCH_CLEANUP_READ_FAILED", `git worktree list failed: ${result.err}`);
	return parseWorktrees(result.out);
}

export function listGitWorktreesSync(repoPath: string): GitWorktreeEntry[] {
	return parseWorktrees(readRequired(repoPath, ["worktree", "list", "--porcelain", "-z"]));
}

function repoFor(projectId: string): string {
	const project = loadProjects().find((candidate) => candidate.id === projectId);
	if (!project) throw new Error(`Unknown project: ${projectId}`);
	return project.path;
}

export function repositoryCleanupKey(projectId: string): string {
	const repo = repoFor(projectId);
	const result = git(repo, ["rev-parse", "--git-common-dir"]);
	if (!result.ok)
		throw new CodedError("BRANCH_CLEANUP_READ_FAILED", `Could not read repository: ${result.err}`);
	const key = canonicalPath(resolve(repo, result.out));
	return process.platform === "win32" ? key.toLowerCase() : key;
}

function readRequired(repo: string, args: string[]): string {
	const result = git(repo, args);
	if (!result.ok)
		throw new CodedError("BRANCH_CLEANUP_READ_FAILED", `Could not inspect branch: ${result.err}`);
	return result.out;
}

function oidOf(repo: string, ref: string): string {
	return readRequired(repo, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

function defaultTarget(repo: string, refs: string): { ref: string; localName: string } {
	const rows = refs
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"));
	const origin = git(repo, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
	if (!origin.ok && origin.err) throw new CodedError("BRANCH_CLEANUP_READ_FAILED", origin.err);
	const remotes = readRequired(repo, ["remote"]).split("\n").filter(Boolean);
	let remoteHead = rows.find(
		([ref, symref]) => ref?.startsWith("refs/remotes/") && ref.endsWith("/HEAD") && symref,
	)?.[1];
	if (!origin.ok) {
		for (const remote of remotes.filter((name) => name !== "origin")) {
			const head = git(repo, ["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
			if (!head.ok && head.err) throw new CodedError("BRANCH_CLEANUP_READ_FAILED", head.err);
			if (head.ok) {
				remoteHead = head.out;
				break;
			}
		}
	}
	const remoteRef = origin.ok
		? origin.out
		: (remoteHead ??
			(rows.some(([ref, symref]) => ref === "refs/remotes/origin/main" && !symref)
				? "refs/remotes/origin/main"
				: undefined));
	if (remoteRef) {
		if (!remoteRef.startsWith("refs/remotes/") || !rows.some(([ref]) => ref === remoteRef))
			throw new CodedError("BRANCH_CLEANUP_READ_FAILED", "Invalid repository default target");
		const name = remoteRef.slice("refs/remotes/".length);
		const remote = remoteNameOf(name, remotes);
		if (!remote)
			throw new CodedError(
				"BRANCH_CLEANUP_READ_FAILED",
				"The default target has no configured remote",
			);
		return { ref: remoteRef, localName: name.slice(remote.length + 1) };
	}
	const local = readRequired(repo, ["symbolic-ref", "--quiet", "HEAD"]);
	if (!local.startsWith("refs/heads/"))
		throw new CodedError("BRANCH_CLEANUP_READ_FAILED", "The default target is not a local branch");
	if (!rows.some(([ref]) => ref === local))
		throw new CodedError(
			"BRANCH_CLEANUP_READ_FAILED",
			"The default target is not an exact Git ref",
		);
	return { ref: local, localName: local.slice("refs/heads/".length) };
}

function parseCommitCount(output: string): number {
	const count = Number(output);
	if (!/^\d+$/.test(output) || !Number.isSafeInteger(count))
		throw new CodedError("BRANCH_CLEANUP_READ_FAILED", "Invalid Git commit count");
	return count;
}

function unmergedCount(repo: string, baseOid: string, oid: string): number {
	return parseCommitCount(readRequired(repo, ["rev-list", "--count", `${baseOid}..${oid}`, "--"]));
}

export async function listBranchesForCleanup(projectId: string): Promise<BranchCleanupList> {
	const repo = repoFor(projectId);
	const [refs, worktrees] = await Promise.all([
		gitAsync(repo, [
			"for-each-ref",
			"--format=%(refname)\t%(symref)\t%(objectname)",
			"refs/heads",
			"refs/remotes",
		]),
		listGitWorktrees(repo),
	]);
	if (!refs.ok) throw new CodedError("BRANCH_CLEANUP_READ_FAILED", refs.err);
	const target = defaultTarget(repo, refs.out);
	assertSafeRef(target.ref);
	const baseOid = oidOf(repo, target.ref);
	const local = refs.out
		.split("\n")
		.map((row) => row.split("\t"))
		.filter(([ref]) => ref?.startsWith("refs/heads/"));
	const branches: BranchCleanupEntry[] = [];
	for (const [ref, , oid] of local) {
		if (!ref || !oid || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid))
			throw new CodedError("BRANCH_CLEANUP_READ_FAILED", "Invalid local branch identity");
		const name = ref.slice("refs/heads/".length);
		const count = await gitAsync(repo, ["rev-list", "--count", `${baseOid}..${oid}`, "--"]);
		if (!count.ok)
			throw new CodedError("BRANCH_CLEANUP_READ_FAILED", `Could not inspect branch: ${count.err}`);
		const worktreePaths = worktrees
			.filter(
				(entry) =>
					entry.branch !== undefined && refersToLocalBranch(`refs/heads/${entry.branch}`, name),
			)
			.map((entry) => entry.path);
		branches.push({
			name,
			oid,
			unmergedCommits: parseCommitCount(count.out),
			worktreePaths,
			...(refersToLocalBranch(`refs/heads/${name}`, target.localName)
				? { blockedReason: "default" as const }
				: worktreePaths.length
					? { blockedReason: "worktree" as const }
					: {}),
		});
	}
	return { baseRef: target.ref, baseOid, branches };
}

export function validateLocalBranchDeletion(
	input: BranchDeleteInput,
	removingPath?: string,
): boolean {
	if (
		typeof input.projectId !== "string" ||
		typeof input.name !== "string" ||
		typeof input.baseRef !== "string" ||
		typeof input.oid !== "string" ||
		typeof input.baseOid !== "string" ||
		(input.allowUnmerged !== undefined && typeof input.allowUnmerged !== "boolean") ||
		(input.confirmName !== undefined && typeof input.confirmName !== "string")
	) {
		throw new CodedError("BRANCH_CLEANUP_INVALID", "Invalid branch deletion request");
	}
	assertSafeRef(input.name);
	assertSafeRef(input.baseRef);
	if (
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.oid) ||
		!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.baseOid)
	) {
		throw new CodedError("BRANCH_CLEANUP_INVALID", "Invalid branch commit identity");
	}
	const repo = repoFor(input.projectId);
	const refs = readRequired(repo, [
		"for-each-ref",
		"--format=%(refname)\t%(symref)",
		"refs/heads",
		"refs/remotes",
	]);
	if (!refs.split("\n").some((row) => row.split("\t")[0] === `refs/heads/${input.name}`))
		throw new CodedError(
			"BRANCH_CLEANUP_STALE",
			"Use the exact branch name from a refreshed preview",
		);
	const target = defaultTarget(repo, refs);
	if (
		target.ref !== input.baseRef ||
		oidOf(repo, target.ref) !== input.baseOid ||
		oidOf(repo, `refs/heads/${input.name}`) !== input.oid
	) {
		throw new CodedError(
			"BRANCH_CLEANUP_STALE",
			"The branch or comparison target changed. Refresh and confirm again.",
		);
	}
	if (refersToLocalBranch(`refs/heads/${input.name}`, target.localName))
		throw new CodedError("BRANCH_CLEANUP_PROTECTED", "The default branch cannot be deleted");
	const occupied = listGitWorktreesSync(repo).some(
		(entry) =>
			entry.branch !== undefined &&
			refersToLocalBranch(`refs/heads/${entry.branch}`, input.name) &&
			(!removingPath || canonicalPath(entry.path) !== canonicalPath(removingPath)),
	);
	if (occupied) throw new CodedError("BRANCH_CLEANUP_OCCUPIED", "The branch is used by a worktree");
	const unmerged = unmergedCount(repo, input.baseOid, input.oid) > 0;
	if (unmerged && (input.allowUnmerged !== true || input.confirmName !== input.name)) {
		throw new CodedError(
			"BRANCH_CLEANUP_CONFIRM_REQUIRED",
			"Type the complete branch name to delete unmerged commits",
		);
	}
	return unmerged;
}

export function deleteLocalBranch(input: BranchDeleteInput): void {
	const unmerged = validateLocalBranchDeletion(input);
	const result = git(repoFor(input.projectId), [
		"branch",
		"--delete",
		...(unmerged ? ["--force"] : []),
		"--",
		input.name,
	]);
	if (!result.ok)
		throw new CodedError("BRANCH_CLEANUP_DELETE_FAILED", `Could not delete branch: ${result.err}`);
}
