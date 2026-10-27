import { existsSync } from "node:fs";
import type {
	BranchCleanupList,
	BranchDeleteInput,
	Workspace,
	WorkspaceRemoveResult,
	WsParams,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { purgeWorkspaceSessions, withWorkspaceSessionsClosed } from "../agent";
import { forgetWorkspaceChanges } from "../changes";
import {
	currentBranch,
	deleteLocalBranch,
	listBranchesForCleanup,
	refersToLocalBranch,
	repositoryCleanupKey,
	validateLocalBranchDeletion,
} from "../git";
import { logger } from "../log";
import { getProjects } from "../projects";
import { removeWorkspaceReviews } from "../reviews";
import { evictSpecIndex } from "../spec";
import { closeWorkspaceTerminals } from "../terminal";
import { settleChangeArtifacts } from "../todos";
import { forgetWorkspaceTurns } from "../turns";
import { stopWatch } from "../watch";
import {
	assertWorktreeRemovable,
	forgetWorkspace,
	getWorkspace,
	listAllWorkspaceRecords,
	reclaimWorktree,
} from "../workspaces";
import { createKeyedLock } from "./reviewLock";

const withRepositoryCleanup = createKeyedLock();
const log = logger("host");

function repositoryWorkspaces(projectId: string): Workspace[] {
	const key = repositoryCleanupKey(projectId);
	const projects = getProjects();
	const records = listAllWorkspaceRecords();
	if (records.some((workspace) => !projects.some((project) => project.id === workspace.projectId)))
		throw new CodedError(
			"BRANCH_CLEANUP_READ_FAILED",
			"A workspace has no project; repository references cannot be verified",
		);
	const projectIds = new Set(
		projects
			.filter((project) => {
				if (project.id === projectId) return true;
				return repositoryCleanupKey(project.id) === key;
			})
			.map((project) => project.id),
	);
	return records.filter((workspace) => projectIds.has(workspace.projectId));
}

function usesBranch(workspace: Workspace, name: string): boolean {
	return [`refs/heads/${workspace.branch}`, workspace.baseBranch, workspace.diffBase].some((ref) =>
		refersToLocalBranch(ref, name),
	);
}

function assertNoWorkspaceReferences(input: BranchDeleteInput, excludingId?: string): void {
	if (
		repositoryWorkspaces(input.projectId).some(
			(workspace) => workspace.id !== excludingId && usesBranch(workspace, input.name),
		)
	)
		throw new CodedError(
			"BRANCH_CLEANUP_REFERENCED",
			"The branch is still referenced by another workspace. Update or remove that workspace first.",
		);
}

export async function branchCleanupList(projectId: string): Promise<BranchCleanupList> {
	const list = await listBranchesForCleanup(projectId);
	const workspaces = repositoryWorkspaces(projectId);
	return {
		...list,
		branches: list.branches.map((branch) => {
			const references = workspaces.filter((workspace) => usesBranch(workspace, branch.name));
			return references.length
				? {
						...branch,
						blockedReason: branch.blockedReason ?? "workspace",
						workspaceNames: references.map((workspace) => workspace.name),
						workspaceIds: references.map((workspace) => workspace.id),
					}
				: branch;
		}),
	};
}

export function deleteBranch(input: BranchDeleteInput): Promise<{ ok: true }> {
	return withRepositoryCleanup(repositoryCleanupKey(input.projectId), async () => {
		assertNoWorkspaceReferences(input);
		deleteLocalBranch(input);
		return { ok: true };
	});
}

export async function removeWorkspaceSafely(
	params: WsParams<"workspace.remove">,
): Promise<WorkspaceRemoveResult> {
	const initial = listAllWorkspaceRecords().find((workspace) => workspace.id === params.id);
	if (!initial && params.deleteBranch)
		throw new CodedError(
			"BRANCH_CLEANUP_STALE",
			"The workspace was already removed. Refresh local branches and confirm again.",
		);
	if (!initial) return { ok: true };
	if (initial.kind === "default") throw new Error("The Default workspace cannot be removed");
	return withRepositoryCleanup(repositoryCleanupKey(initial.projectId), async () => {
		const ws = listAllWorkspaceRecords().find((workspace) => workspace.id === params.id);
		if (!ws && params.deleteBranch)
			throw new CodedError(
				"BRANCH_CLEANUP_STALE",
				"The workspace was already removed. Refresh local branches and confirm again.",
			);
		if (!ws) return { ok: true };
		if (ws.kind === "default") throw new Error("The Default workspace cannot be removed");
		if (ws.kind === "external" && params.deleteBranch)
			throw new CodedError(
				"BRANCH_CLEANUP_PROTECTED",
				"Removing an external workspace cannot delete its branch",
			);
		assertWorktreeRemovable(ws);
		const deletion = params.deleteBranch
			? { ...params.deleteBranch, projectId: ws.projectId }
			: undefined;
		const validateDeletion = () => {
			if (!deletion) return;
			if (deletion.name !== getWorkspace(ws.id).branch)
				throw new CodedError(
					"BRANCH_CLEANUP_STALE",
					"The workspace branch changed. Refresh and confirm again.",
				);
			validateLocalBranchDeletion(deletion, ws.worktreePath);
			assertNoWorkspaceReferences(deletion, ws.id);
		};
		validateDeletion();
		return withWorkspaceSessionsClosed(ws.id, async () => {
			closeWorkspaceTerminals(ws.id);
			await settleChangeArtifacts(ws.id);
			const current = getWorkspace(ws.id);
			if (
				current.projectId !== ws.projectId ||
				current.kind !== ws.kind ||
				current.worktreePath !== ws.worktreePath
			)
				throw new CodedError(
					"WORKSPACE_UNSAFE_PATH",
					"The workspace identity changed during cleanup",
				);
			closeWorkspaceTerminals(ws.id);
			assertWorktreeRemovable(current);
			validateDeletion();
			if (
				deletion &&
				existsSync(ws.worktreePath) &&
				currentBranch(ws.worktreePath) !== deletion.name
			)
				throw new CodedError(
					"BRANCH_CLEANUP_STALE",
					"The worktree branch changed. Refresh and confirm again.",
				);
			stopWatch(ws.id);
			reclaimWorktree(ws);
			const result: WorkspaceRemoveResult = {
				ok: true,
				...(deletion ? { branchDeleted: false } : {}),
			};
			if (deletion) {
				try {
					assertNoWorkspaceReferences(deletion, ws.id);
					deleteLocalBranch(deletion);
					result.branchDeleted = true;
				} catch (error) {
					result.retainedBranch = deletion.name;
					result.cleanupError = error instanceof Error ? error.message : "Branch deletion failed";
					log.warn("workspace branch was retained after reclamation", error as Error);
				}
			}
			try {
				await purgeWorkspaceSessions(ws.id, ws.worktreePath);
			} catch (error) {
				result.cleanupError = [
					result.cleanupError,
					error instanceof Error ? error.message : "History cleanup failed",
				]
					.filter(Boolean)
					.join("; ");
				log.warn("workspace history cleanup failed", error as Error);
			}
			evictSpecIndex(ws.id);
			removeWorkspaceReviews(ws.id);
			forgetWorkspaceChanges(ws.id);
			forgetWorkspaceTurns(ws.id);
			forgetWorkspace(ws.id);
			return result;
		});
	});
}
