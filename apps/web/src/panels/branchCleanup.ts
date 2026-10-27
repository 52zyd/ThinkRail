import {
	BRANCH_CLEANUP_PROTOCOL_VERSION,
	type BranchCleanupEntry,
	type BranchCleanupList,
	type BranchDeleteInput,
} from "@thinkrail/contracts";
import type { MessageKey } from "@thinkrail/locales";
import { i18n } from "@thinkrail/locales/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorText, getTransport, wsErrorCode } from "../transport";

const CLEANUP_ERRORS: Record<string, MessageKey> = {
	BRANCH_CLEANUP_STALE: "panels.branchCleanup.stale",
	BRANCH_CLEANUP_PROTECTED: "panels.branchCleanup.blocked.default",
	BRANCH_CLEANUP_OCCUPIED: "panels.branchCleanup.blocked.worktree",
	BRANCH_CLEANUP_REFERENCED: "panels.branchCleanup.blocked.workspace",
	BRANCH_CLEANUP_CONFIRM_REQUIRED: "panels.branchCleanup.confirmRequired",
	WORKSPACE_DIRTY: "panels.removeWorkspace.dirty",
	WORKSPACE_UNSAFE_PATH: "panels.removeWorkspace.unsafePath",
	WORKSPACE_RECLAIM_FAILED: "panels.removeWorkspace.reclaimFailed",
};

export function branchCleanupError(error: unknown, fallback: string): string {
	const key = CLEANUP_ERRORS[wsErrorCode(error) ?? ""];
	return key ? i18n.t(key) : errorText(error, fallback);
}

export function supportsBranchCleanup(version: number | null): boolean {
	return version !== null && version >= BRANCH_CLEANUP_PROTOCOL_VERSION;
}

export function branchDeletionInput(
	list: BranchCleanupList,
	branch: BranchCleanupEntry,
	confirmName: string,
): Omit<BranchDeleteInput, "projectId"> {
	return {
		name: branch.name,
		oid: branch.oid,
		baseRef: list.baseRef,
		baseOid: list.baseOid,
		...(branch.unmergedCommits > 0 ? { allowUnmerged: true, confirmName } : {}),
	};
}

export function canConfirmBranchDeletion(branch: BranchCleanupEntry, confirmName: string): boolean {
	return branch.unmergedCommits === 0 || confirmName === branch.name;
}

export function useBranchCleanupPreview(projectId: string, open: boolean, fallback: string) {
	const [list, setList] = useState<BranchCleanupList | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const generation = useRef(0);
	const refresh = useCallback(async () => {
		const mine = ++generation.current;
		setList(null);
		setError(null);
		setLoading(true);
		try {
			const next = await getTransport().request("git.listBranchesForCleanup", { projectId });
			if (generation.current === mine) setList(next);
		} catch (cause) {
			if (generation.current === mine) setError(branchCleanupError(cause, fallback));
		}
		if (generation.current === mine) setLoading(false);
	}, [projectId, fallback]);
	useEffect(() => {
		if (!open) return;
		void refresh();
		return () => {
			generation.current += 1;
		};
	}, [open, refresh]);
	return { list, error, loading, refresh };
}
