import type { Workspace } from "@thinkrail/contracts";
import { T, useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { useState } from "react";
import { isExternalWorkspace, toast, useAppStore, workspaceName } from "../store";
import { getTransport } from "../transport";
import { BranchDeleteFields } from "./BranchDeleteFields";
import {
	branchCleanupError,
	branchDeletionInput,
	canConfirmBranchDeletion,
	supportsBranchCleanup,
	useBranchCleanupPreview,
} from "./branchCleanup";
import { ConfirmDialog } from "./ConfirmDialog";
import { removeWorkspace } from "./workspaceActions";

export function RemoveWorkspaceDialog({
	workspace,
	open,
	onOpenChange,
	onClosedAutoFocus,
}: {
	workspace: Workspace;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onClosedAutoFocus?: () => void;
}) {
	const t = useT();
	const supported = useAppStore((s) => supportsBranchCleanup(s.protocolVersion));
	const isExternal = isExternalWorkspace(workspace);
	if (supported)
		return open ? (
			<SafeRemoveWorkspaceDialog
				key={workspace.id}
				workspace={workspace}
				onOpenChange={onOpenChange}
				{...(onClosedAutoFocus ? { onClosedAutoFocus } : {})}
			/>
		) : null;
	const branch = <span key="branch" className="tr-text-emphasis text-text-default" />;
	return (
		<ConfirmDialog
			open={open}
			onOpenChange={onOpenChange}
			title={
				isExternal
					? t("panels.removeWorkspace.titleExternal", { name: workspaceName(t, workspace) })
					: t("panels.removeWorkspace.title", { name: workspaceName(t, workspace) })
			}
			description={
				<T
					i18nKey={
						isExternal
							? "panels.removeWorkspace.descriptionExternal"
							: "panels.removeWorkspace.description"
					}
					values={{ branch: workspace.branch }}
					components={[branch]}
				/>
			}
			confirmLabel={isExternal ? t("panels.removeWorkspace.confirmExternal") : t("common.remove")}
			destructive
			confirmTestId="confirm-remove"
			onConfirm={() => removeWorkspace(workspace.id)}
			{...(onClosedAutoFocus ? { onClosedAutoFocus } : {})}
		/>
	);
}

function SafeRemoveWorkspaceDialog({
	workspace,
	onOpenChange,
	onClosedAutoFocus,
}: {
	workspace: Workspace;
	onOpenChange: (open: boolean) => void;
	onClosedAutoFocus?: () => void;
}) {
	const t = useT();
	const external = isExternalWorkspace(workspace);
	const preview = useBranchCleanupPreview(
		workspace.projectId,
		!external,
		t("panels.branchCleanup.listFailed"),
	);
	const [deleteBranch, setDeleteBranch] = useState(false);
	const [confirmName, setConfirmName] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const branch = preview.list?.branches.find((entry) => entry.name === workspace.branch);
	const protectedBranch =
		branch &&
		(branch.blockedReason === "default" ||
			branch.worktreePaths.some((path) => path !== workspace.worktreePath) ||
			branch.workspaceIds?.some((id) => id !== workspace.id));
	const canDelete = !!branch && !protectedBranch;
	const remove = async () => {
		if (
			busy ||
			(deleteBranch &&
				(!canDelete || !branch || !preview.list || !canConfirmBranchDeletion(branch, confirmName)))
		)
			return;
		setBusy(true);
		setError(null);
		const deletion =
			deleteBranch && branch && preview.list
				? branchDeletionInput(preview.list, branch, confirmName)
				: undefined;
		const params = {
			id: workspace.id,
			...(deletion ? { deleteBranch: deletion } : {}),
		};
		try {
			const result = await getTransport().request("workspace.remove", params);
			if (result.cleanupError) {
				if (result.retainedBranch)
					toast.error(t("panels.removeWorkspace.partial", { branch: result.retainedBranch }));
				else toast.error(t("panels.removeWorkspace.partialHistory"));
			}
			onOpenChange(false);
		} catch (cause) {
			setError(branchCleanupError(cause, t("panels.workspaceActions.removeFailed")));
		}
		setBusy(false);
	};
	return (
		<Dialog
			open
			onOpenChange={(next) => {
				if (!busy) onOpenChange(next);
			}}
		>
			<DialogContent
				role="alertdialog"
				hideClose
				data-testid="confirm-dialog"
				className="max-h-[90dvh] max-w-[28rem] overflow-y-auto"
				onCloseAutoFocus={
					onClosedAutoFocus
						? (event) => {
								event.preventDefault();
								onClosedAutoFocus();
							}
						: undefined
				}
			>
				<DialogHeader>
					<DialogTitle>
						{t(external ? "panels.removeWorkspace.titleExternal" : "panels.removeWorkspace.title", {
							name: workspaceName(t, workspace),
						})}
					</DialogTitle>
					<DialogDescription>
						{t(
							external
								? "panels.removeWorkspace.safeExternal"
								: "panels.removeWorkspace.safeDescription",
						)}
					</DialogDescription>
				</DialogHeader>
				{!external ? (
					<>
						<label className="flex min-w-0 items-start gap-8 tr-text-ui">
							<input
								type="checkbox"
								data-testid="remove-delete-branch"
								checked={deleteBranch}
								disabled={busy || !canDelete}
								onChange={(event) => {
									setDeleteBranch(event.target.checked);
									setConfirmName("");
								}}
								className="mt-4 shrink-0 accent-primary focus-visible:outline-primary"
							/>
							<span className="min-w-0 break-words">
								{t("panels.removeWorkspace.deleteBranch", { branch: workspace.branch })}
							</span>
						</label>
						{preview.loading ? (
							<p className="text-text-muted tr-text-ui">{t("panels.branchCleanup.loading")}</p>
						) : null}
						{preview.error ? (
							<p role="alert" className="break-words text-feedback-error tr-text-ui">
								{preview.error}
							</p>
						) : null}
						{protectedBranch ? (
							<p className="text-text-muted tr-text-ui">
								{t("panels.removeWorkspace.branchProtected")}
							</p>
						) : null}
						{deleteBranch && branch && preview.list ? (
							<BranchDeleteFields
								branch={branch}
								baseRef={preview.list.baseRef}
								confirmName={confirmName}
								onConfirmNameChange={setConfirmName}
								disabled={busy}
							/>
						) : null}
						<Button
							variant="ghost"
							disabled={busy || preview.loading}
							onClick={() => {
								setDeleteBranch(false);
								setConfirmName("");
								void preview.refresh();
							}}
						>
							{t("panels.branchCleanup.refresh")}
						</Button>
					</>
				) : null}
				{error ? (
					<p role="alert" className="break-words text-feedback-error tr-text-ui">
						{error}
					</p>
				) : null}
				<DialogFooter>
					<Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="destructive"
						data-testid="confirm-remove"
						disabled={
							busy ||
							(deleteBranch &&
								(!canDelete || !branch || !canConfirmBranchDeletion(branch, confirmName)))
						}
						onClick={() => void remove()}
					>
						{busy
							? t("panels.removeWorkspace.removing")
							: t(external ? "panels.removeWorkspace.confirmExternal" : "common.remove")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
