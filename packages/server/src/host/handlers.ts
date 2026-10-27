import { mkdirSync } from "node:fs";
import type {
	OpenBranchReview,
	ReviewComment,
	ReviewFixDetails,
	ReviewSendResult,
	TemplateReadLocation,
	ThinkingLevel,
	WireModel,
	Workspace,
	WsMethodName,
	WsParams,
	WsResult,
} from "@thinkrail/contracts";
import {
	BRANCH_CLEANUP_PROTOCOL_VERSION,
	BRANCH_STATUS_PROTOCOL_VERSION,
	isControlMessage,
	WORKSPACE_SETTLE_PROTOCOL_VERSION,
} from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import {
	abortSession,
	acknowledgeCompletion,
	admissionContextFor,
	answerQuestion,
	applyPiResourceTrust,
	cancelMcpProbe,
	clampThinkingForModel,
	clearQueueSession,
	compactSession,
	createSession,
	deleteSession,
	discoverCompatibleModels,
	ensureSessionAttached,
	followUpSession,
	getSessionCommands,
	getSessionMessages,
	getSessionResources,
	getSessionStats,
	getSessionWorkspaceId,
	hasSession,
	isHostResourceId,
	isMcpLoginId,
	isPiSessionId,
	listAvailableModels,
	listCompatibleProviders,
	listModelContextSettings,
	listProjectAliasSkillNames,
	listSessionStates,
	listSessions,
	listSkillCatalog,
	listSkillCommands,
	markWorkspaceRead,
	markWorkspaceUnread,
	notifyExtUi,
	nudgeSession,
	projectTrustSummary,
	promptSession,
	readBackgroundCommandOutput,
	readChildTranscript,
	refreshAvailableModels,
	refreshSubagentConcurrency,
	refreshSubagentTools,
	reloadSessionResources,
	removeCompatibleProvider,
	removeQueuedSession,
	removeSession,
	renameSession,
	replyMcpProbe,
	resolveExtUi,
	saveCompatibleProvider,
	sendReviewFixToSession,
	setModelContextWindow,
	setSessionModel,
	setSessionThinkingLevel,
	steerSession,
	stopAllSubagents,
	stopBackgroundCommand,
	stopSubagent,
} from "../agent";
import { suggestPrDescription } from "../assist";
import {
	cancelLogin,
	connectJbcentral,
	disconnectJbcentral,
	getJbcentralQuota,
	getProviderStatus,
	jbcentralLogin,
	logoutProvider,
	resolveLogin,
	startLogin,
	startProxyJbcentral,
	updateJbcentral,
} from "../auth";
import { findBranchReviewOutcome, providerFromRemoteUrl } from "../branch-review";
import { revertChange, undoChange } from "../changes";
import { selectDirectory } from "../dialog";
import { listAvailableEditors, openEditor, revealInFileManager } from "../editors";
import { listExtensionCatalog } from "../extensions";
import { recordAcceptedMessage, respondToInterview } from "../feedback";
import { readDir, readFile } from "../fs";
import {
	commitsAheadOf,
	countPushDivergence,
	countPushTargetDivergence,
	gitDiffFile,
	gitStatus,
	ignoredPaths,
	listBranches,
	listCommits,
	originUrls,
	type PushTargetStatus,
	prefetchBranch,
	remoteRefOid,
} from "../git";
import { githubAuthStatus, githubRefresh } from "../github";
import { clampLimit, getHistoryIndex } from "../history";
import { localesDir, readLocalLocales } from "../locales";
import { logger } from "../log";
import {
	deleteRemoteBranch,
	mergePr,
	onBaseBranch,
	openPr,
	prDraftInput,
	previewPr,
	pushBranch,
	readyPr,
	reopenPr,
} from "../pr";
import {
	acknowledgeProjectSkills,
	closeProject,
	initProject,
	inspectProjectPath,
	listProjects,
	openProject,
	renameProject,
	setProjectGroupEnabled,
	setProjectSkillEnabled,
	setProjectTrust,
} from "../projects";
import {
	addComment,
	buildReviewFixDetails,
	buildSendPackage,
	clearReview,
	deleteComment,
	fileReviewSession,
	getReviewSnapshot,
	markCommentsSent,
	markFileDone,
	REVIEW_LEVEL_KEY,
	reviewSessionKey,
	rollbackSend,
	sendableComments,
	updateComment,
} from "../reviews";
import { getConfig, noteRecentModel, updateConfig } from "../settings";
import { projectHasSpecs, specGraph } from "../spec";
import {
	deleteTemplate,
	getTemplate,
	listTemplates,
	saveTemplate,
	templateDirs,
} from "../templates";
import {
	attachTerminal,
	closeTerminalTab,
	listTerminals,
	reserveTerminal,
	resizeTerminal,
	writeTerminal,
} from "../terminal";
import {
	addTodo,
	approveTodoReview,
	countOpenTodos,
	generateTodoSummary,
	listTodos,
	removeSessionTodoWindows,
	removeTodo,
	requestTodoFix,
	rollbackTodoFix,
	type TodoReviewRecord,
	updateTodo,
} from "../todos";
import { listTurns } from "../turns";
import { ensureWatch } from "../watch";
import {
	createWorkspace,
	ensureWorkspaceScratchDir,
	getWorkspace,
	listAllWorkspaceRecords,
	listExistingWorktrees,
	listWorkspaceRecords,
	listWorkspaces,
	openExistingWorktree,
	recordWorkspaceActivity,
	refreshUserOwnedWorkspace,
	renameWorkspace,
	settleWorkspace,
	setWorkspaceDiffBase,
	setWorkspaceReview,
	setWorkspaceSkillOverride,
	setWorkspaceSubagentMaxConcurrent,
	setWorkspaceSubagentsOverride,
	unsettleWorkspace,
	workspaceDiffStats,
} from "../workspaces";
import { ackSend } from "./ackSend";
import { branchCleanupList, deleteBranch, removeWorkspaceSafely } from "./branchCleanup";
import { nudgeBaseRefWorkspaces } from "./fsNudge";
import { buildHistoryScope } from "./historyScope";
import { provisionInitialTerminal } from "./initialTerminal";
import {
	mcpAdd,
	mcpApprove,
	mcpList,
	mcpLogin,
	mcpLogout,
	mcpReadLog,
	mcpReadOutput,
	mcpReconnect,
	mcpRemove,
	mcpRevokeToolGrant,
	mcpSetProjectOverride,
	mcpSetSessionOverride,
	mcpShareWithRepo,
	mcpTestConnection,
	mcpUpdate,
} from "./mcp";
import { resolveNewChatModel } from "./newChatModel";
import { planReviewRunning } from "./planReviewQueue";
import { startPlanReview } from "./requestReview";
import { withChangeLock, withReviewLock } from "./reviewLock";
import { scheduleLifecyclePass } from "./settledLifecycle";
import {
	claimItemFix,
	clearChangesRequestedIfResolved,
	isItemUnderActiveReview,
	itemFixFindings,
	markClientStale,
	releaseItemFix,
} from "./todoReview";

const log = logger("host");
export interface RequestContext {
	clientKey: string;
	/** The socket's advertised protocol; absent for in-process callers, who speak the current one. */
	protocolVersion?: number;
	runHostUpdate?: () => void;
}
type WsHandler<M extends WsMethodName> = (
	params: WsParams<M>,
	ctx: RequestContext,
) => WsResult<M> | Promise<WsResult<M>>;
type WsHandlers = {
	[M in WsMethodName]: WsHandler<M>;
};
async function sendUserMessage(
	text: string,
	clientKey: string,
	operation: () => Promise<void>,
): Promise<{ ok: true }> {
	const control = isControlMessage(text);
	await ackSend(operation());
	if (!control) {
		recordAcceptedMessage(clientKey);
	}
	return { ok: true };
}
function resolveTemplateReadDirs(params: TemplateReadLocation) {
	const { workspaceId, projectId } = params;
	if (workspaceId !== undefined && projectId !== undefined) {
		throw new Error("Template reads accept either workspaceId or projectId, not both");
	}
	if (workspaceId !== undefined) return templateDirs(getWorkspace(workspaceId).worktreePath);
	if (projectId === undefined) return templateDirs();
	const project = listProjects().find((candidate) => candidate.id === projectId);
	if (!project) throw new Error(`Unknown project: ${projectId}`);
	return templateDirs(project.path);
}
function fireReviewPrompt(
	workspaceId: string,
	comments: readonly ReviewComment[],
	sessionId: string,
	pkg: string,
	send: (sessionId: string, text: string) => Promise<void> = promptSession,
): void {
	const ids = comments.map((c) => c.id);
	void ackSend(send(sessionId, pkg))
		.catch((err) => {
			rollbackSend(workspaceId, ids, sessionId);
			notifyExtUi(
				sessionId,
				`Review send failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		})
		.catch(() => {
			log.warn("review send rollback failed");
		});
}
function fireTodoFixPrompt(
	p: {
		workspaceId: string;
		sessionId: string;
		id: string;
	},
	pkg: string,
	details: ReviewFixDetails,
	previous: TodoReviewRecord | undefined,
	requested: TodoReviewRecord,
	findings: readonly ReviewComment[],
): void {
	const findingIds = findings.map((c) => c.id);
	void ackSend(sendReviewFixToSession(p.sessionId, pkg, details))
		.catch((err) => {
			rollbackTodoFix(p, previous, requested);
			if (findingIds.length > 0) rollbackSend(p.workspaceId, findingIds, p.sessionId);
			notifyExtUi(
				p.sessionId,
				`Fix request send failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		})
		.catch((err) => {
			log.warn("todo fix rollback failed", err);
		})
		.finally(() => releaseItemFix(p.sessionId, p.id));
}
function reviewSendGroups(
	comments: ReviewComment[],
	sessionId: string | undefined,
): ReviewComment[][] {
	if (comments.length === 0) return [];
	if (sessionId) return [comments];
	const groups = new Map<string, ReviewComment[]>();
	for (const comment of comments) {
		const key = reviewSessionKey(comment);
		groups.set(key, [...(groups.get(key) ?? []), comment]);
	}
	return [...groups.values()];
}
async function sendToFileChat(
	workspaceId: string,
	comments: ReviewComment[],
	opts: {
		model?: WireModel;
		thinkingLevel?: ThinkingLevel;
		sessionId?: string;
	},
): Promise<ReviewSendResult> {
	const ids = comments.map((c) => c.id);
	const pkg = await buildSendPackage(workspaceId, comments);
	const ws = getWorkspace(workspaceId);
	const first = comments[0];
	const path = first ? reviewSessionKey(first) : REVIEW_LEVEL_KEY;
	const existing = opts.sessionId ?? (await fileReviewSession(workspaceId, path));
	if (existing && (await ensureSessionAttached(existing, workspaceId, ws.worktreePath))) {
		await markCommentsSent(workspaceId, ids, existing);
		fireReviewPrompt(workspaceId, comments, existing, pkg, followUpSession);
		return {
			sessionId: existing,
			model: null,
			thinkingLevel: "medium",
			reused: true,
		};
	}
	if (existing) {
		log.warn(
			`review ${workspaceId}: linked chat ${existing} is no longer on disk — starting a new review chat`,
		);
	}
	ensureWorkspaceScratchDir(ws);
	const defaults = await resolveNewChatModel(opts);
	const created = await createSession({
		cwd: ws.worktreePath,
		workspaceId,
		...(defaults.model ? { model: defaults.model } : {}),
		thinkingLevel: defaults.thinkingLevel,
	});
	await markCommentsSent(workspaceId, ids, created.sessionId);
	fireReviewPrompt(workspaceId, comments, created.sessionId, pkg);
	return { ...created, reused: false };
}
function sessionStateWorkspace(workspace: Workspace) {
	return { id: workspace.id, projectId: workspace.projectId, cwd: workspace.worktreePath };
}
function resourceCwd(workspaceId: string): string {
	try {
		return getWorkspace(workspaceId).worktreePath;
	} catch {
		throw new CodedError("RESOURCE_UNAVAILABLE", "Session resources unavailable");
	}
}
function resourceParams<K extends string>(params: unknown, keys: K[]): Record<K, string> {
	if (!params || typeof params !== "object" || Array.isArray(params))
		throw new Error("Invalid resource ids");
	if (Object.keys(params).some((key) => !keys.some((allowed) => allowed === key)))
		throw new Error("Invalid resource ids");
	const result = {} as Record<K, string>;
	for (const key of keys) {
		const value: unknown = Reflect.get(params, key);
		const sessionId = key === "sessionId" || key === "parentSessionId" || key === "childSessionId";
		if (typeof value !== "string" || !(sessionId ? isPiSessionId(value) : isHostResourceId(value)))
			throw new Error("Invalid resource ids");
		result[key] = value;
	}
	return result;
}
const handlers: WsHandlers = {
	"project.open": (params) => openProject(params.path),
	"project.inspect": (params) => inspectProjectPath(params.path),
	"project.init": (params) => initProject(params.path),
	"project.list": () => listProjects(),
	"project.hasSpecs": (params) => {
		const { projectId } = params;
		const project = listProjects().find((p) => p.id === projectId);
		return { hasSpecs: project ? projectHasSpecs(project.path) : false };
	},
	"project.close": (params) => {
		closeProject(params.id);
		return { ok: true } as const;
	},
	"project.rename": (params) => renameProject(params.id, params.name),
	"project.setTrust": async (p) => {
		const project = listProjects().find((candidate) => candidate.id === p.id);
		if (!project) throw new Error(`Unknown project: ${p.id}`);
		const acknowledged =
			p.trusted && project.trusted !== true
				? await listProjectAliasSkillNames(project.path)
				: undefined;
		const updated = setProjectTrust(p.id, p.trusted, acknowledged, {
			resources: p.resources === true,
		});
		const reloads = await applyPiResourceTrust(
			listWorkspaceRecords(p.id).map((workspace) => workspace.id),
		);
		const failed = Object.values(reloads).filter((disposition) => disposition === "failed").length;
		if (failed > 0) {
			throw new Error(
				`Trust was ${p.trusted ? "granted" : "revoked"}, but ${failed} open ${failed === 1 ? "chat" : "chats"} could not reload and still ${failed === 1 ? "runs" : "run"} with the previous trust — close or reload ${failed === 1 ? "it" : "them"}.`,
			);
		}
		return updated;
	},
	"workspace.create": async (p) => {
		return provisionInitialTerminal(await createWorkspace(p.projectId, p.name, p.baseRef));
	},
	"workspace.listExisting": (params) => listExistingWorktrees(params.projectId),
	"workspace.openExisting": async (p) => {
		return provisionInitialTerminal(await openExistingWorktree(p.projectId, p.path));
	},
	"workspace.rename": (p) => {
		return renameWorkspace(p.id, p.name);
	},
	"workspace.list": async (p) => {
		const rows = (
			await listWorkspaces(p.projectId, { includeDiffStats: p.includeDiffStats ?? true })
		).map((workspace) => ({ ...workspace, ...provisionInitialTerminal(workspace) }));
		void scheduleLifecyclePass(p.projectId).catch(() =>
			log.warn(`settled lifecycle pass failed for project ${p.projectId}`),
		);
		return rows;
	},
	"workspace.openReview": async (p, ctx) => {
		const ws = getWorkspace(p.workspaceId);
		const fresh = shouldRefreshOpenReview(p.allowCached);
		const [outcome, divergence] = await Promise.all([
			findBranchReviewOutcome(ws.worktreePath, ws.branch, { fresh }),
			// Only pay the network fetch on a fresh lookup (focus / explicit refresh), not a cached activation.
			countPushDivergence(ws.worktreePath, ws.branch, { fetch: fresh }),
		]);
		if (outcome.reliable) setWorkspaceReview(ws.id, outcome.value, ws.branch);
		const review = openReviewForClient(outcome.value, ctx.protocolVersion);
		if (!review) return review;
		const { details: _details, ...reference } = review;
		return {
			...reference,
			...(divergence && divergence.ahead > 0 ? { unpushedCommits: divergence.ahead } : {}),
			...(divergence && divergence.behind > 0 ? { behindCommits: divergence.behind } : {}),
		};
	},
	"workspace.branchStatus": async (p, ctx) => {
		const ws = getWorkspace(p.workspaceId);
		const fresh = shouldRefreshOpenReview(p.allowCached);
		const origin = await originUrls(ws.worktreePath);
		const splitPushUrl = origin.push !== origin.fetch ? origin.push : null;
		const [outcome, measured, aheadOfBase] = await Promise.all([
			findBranchReviewOutcome(ws.worktreePath, ws.branch, { fresh }),
			(splitPushUrl
				? countPushTargetDivergence(ws.worktreePath, ws.branch, splitPushUrl)
				: countPushDivergence(ws.worktreePath, ws.branch, {
						fetch: fresh && p.skipFetch !== true,
					}).then(
						(divergence): PushTargetStatus =>
							divergence ? { published: true, ...divergence } : { published: false },
					)
			).catch(() => undefined),
			commitsAheadOf(ws.worktreePath, ws.baseBranch),
		]);
		if (outcome.reliable) setWorkspaceReview(ws.id, outcome.value, ws.branch);
		return {
			hasOrigin: origin.push !== null,
			provider: origin.push ? providerFromRemoteUrl(origin.push) : null,
			pushesElsewhere: splitPushUrl !== null,
			published:
				measured?.published ??
				(splitPushUrl ? null : remoteRefOid(ws.worktreePath, `origin/${ws.branch}`) !== null),
			...(measured?.published && measured.ahead !== undefined && measured.behind !== undefined
				? { ahead: measured.ahead, behind: measured.behind }
				: {}),
			aheadOfBase,
			onBase: onBaseBranch(ws),
			review: openReviewForClient(outcome.value, ctx.protocolVersion),
		};
	},
	"workspace.push": async (p) => {
		recordWorkspaceActivity(p.workspaceId);
		return pushBranch(p);
	},
	"workspace.deleteRemoteBranch": async (p) => {
		recordWorkspaceActivity(p.workspaceId);
		await deleteRemoteBranch(p);
		return { ok: true } as const;
	},
	"workspace.settle": (params) => settleWorkspace(params.id),
	"workspace.unsettle": (params) => unsettleWorkspace(params.id),
	"workspace.markUnread": async (params) => ({
		record: await markWorkspaceUnread(sessionStateWorkspace(getWorkspace(params.id))),
	}),
	"workspace.markRead": async (params) => ({
		records: await markWorkspaceRead(sessionStateWorkspace(getWorkspace(params.id))),
	}),
	"workspace.remove": (params, ctx) => {
		if (params.deleteBranch) requireBranchCleanup(ctx);
		return removeWorkspaceSafely(params);
	},
	"workspace.diffStats": (params) => workspaceDiffStats(params.id),
	"workspace.openIn": (p) => {
		openEditor(p.editor, getWorkspace(p.id).worktreePath);
		return { ok: true } as const;
	},
	"workspace.reveal": (params) => {
		revealInFileManager(getWorkspace(params.id).worktreePath);
		return { ok: true } as const;
	},
	"editor.list": () => listAvailableEditors(),
	"git.listBranches": (params) => listBranches(params.projectId),
	"git.listBranchesForCleanup": (params, ctx) => {
		requireBranchCleanup(ctx);
		return branchCleanupList(params.projectId);
	},
	"git.deleteBranch": (params, ctx) => {
		requireBranchCleanup(ctx);
		return deleteBranch(params);
	},
	"git.prefetch": async (p) => {
		const { ok, moved } = await prefetchBranch(p.projectId, p.ref);
		if (moved) nudgeBaseRefWorkspaces(p.projectId, p.ref);
		return { ok };
	},
	"github.authStatus": () => githubAuthStatus(),
	"github.refresh": () => githubRefresh(),
	"pr.preview": (params, ctx) =>
		previewPr(
			params.sessionId && !params.source && !supportsBranchStatus(ctx.protocolVersion)
				? { ...params, source: "plan" }
				: params,
		),
	"pr.generate": async (params) => ({
		body: await suggestPrDescription(await prDraftInput(params)),
	}),
	"pr.ready": async (p) => {
		recordWorkspaceActivity(p.workspaceId);
		await readyPr(p);
		return { ok: true } as const;
	},
	"pr.merge": (p) => {
		recordWorkspaceActivity(p.workspaceId);
		return mergePr(p);
	},
	"pr.reopen": async (p) => {
		recordWorkspaceActivity(p.workspaceId);
		await reopenPr(p);
		return { ok: true } as const;
	},
	"pr.open": async (p) => {
		refreshUserOwnedWorkspace(p.workspaceId);
		recordWorkspaceActivity(p.workspaceId);
		const { branch, ...result } = await openPr(p);
		if (result.review) {
			setWorkspaceReview(
				p.workspaceId,
				{
					...result.review,
					state: "open",
					...(result.url ? { url: result.url } : {}),
				},
				branch,
			);
		}
		return result;
	},
	"dialog.selectDirectory": () => selectDirectory(),
	"fs.readDir": async (p) => {
		void ensureWatch(p.workspaceId);
		const nodes = readDir(p.workspaceId, p.path);
		const ignored = await ignoredPaths(
			getWorkspace(p.workspaceId).worktreePath,
			nodes.map((node) => node.path),
		);
		return ignored.size === 0
			? nodes
			: nodes.map((node) => (ignored.has(node.path) ? { ...node, gitignored: true } : node));
	},
	"fs.readFile": (p) => {
		void ensureWatch(p.workspaceId);
		return readFile(p.workspaceId, p.path);
	},
	"spec.graph": (p) => {
		void ensureWatch(p.workspaceId);
		return specGraph(p.workspaceId);
	},
	"todo.list": (p) => listTodos(p),
	"todo.add": (p) => addTodo(p),
	"todo.update": (p) => updateTodo(p),
	"todo.remove": (p) => removeTodo(p, () => isItemUnderActiveReview(p.sessionId, p.id)),
	"todo.review": (params) => approveTodoReview(params),
	"todo.startReview": async (p) => {
		const ws = getWorkspace(p.workspaceId);
		if (!(await ensureSessionAttached(p.sessionId, p.workspaceId, ws.worktreePath)))
			throw new Error("This plan's chat is no longer on disk — can't review.");
		if (!startPlanReview(p.workspaceId, p.sessionId, p.id))
			throw new Error("This step is already being reviewed.");
		return { ok: true };
	},
	"todo.reviewAll": async (p) => {
		const ws = getWorkspace(p.workspaceId);
		if (!(await ensureSessionAttached(p.sessionId, p.workspaceId, ws.worktreePath)))
			throw new Error("This plan's chat is no longer on disk — can't review.");
		const plan = await listTodos({ workspaceId: p.workspaceId, sessionId: p.sessionId });
		const items = [
			...plan.todos,
			...plan.groups.flatMap((g) => g.todos),
			...(plan.adoptedCommits ?? []),
		];
		const targets = items.filter((it) => {
			const r = it.review;
			return (
				r !== undefined &&
				!(r.state === "reviewed" && (r.unreviewedShas?.length ?? 0) === 0) &&
				r.reviewing !== true
			);
		});
		const started = targets.filter((it) => startPlanReview(p.workspaceId, p.sessionId, it.id));
		if (started.length === 0 && planReviewRunning(p.workspaceId, p.sessionId))
			return { ok: true, total: 0, alreadyRunning: true };
		return { ok: true, total: started.length };
	},
	"todo.generateSummary": (params) => generateTodoSummary(params),
	"todo.requestFix": async (p) => {
		if (!claimItemFix(p.sessionId, p.id))
			throw new Error(`A fix request is already active for ${p.id}.`);
		try {
			const ws = getWorkspace(p.workspaceId);
			if (!(await ensureSessionAttached(p.sessionId, p.workspaceId, ws.worktreePath))) {
				throw new Error("This plan's chat is no longer on disk — can't send the fix request.");
			}
			const prepared = await withReviewLock(p.workspaceId, async () => {
				const request = requestTodoFix(p);
				try {
					const reviewId = (await getReviewSnapshot(p.workspaceId)).review.id;
					const findings = await itemFixFindings(p);
					const details = buildReviewFixDetails({
						itemId: p.id,
						itemTitle: request.itemTitle,
						reviewId,
						note: p.feedback.trim(),
						comments: findings,
					});
					if (findings.length === 0) return { ...request, fixText: request.pkg, details, findings };
					const fixText = `${request.pkg}\n\n${await buildSendPackage(p.workspaceId, findings)}`;
					await markCommentsSent(
						p.workspaceId,
						findings.map((c) => c.id),
						p.sessionId,
					);
					return { ...request, fixText, details, findings };
				} catch (error) {
					rollbackTodoFix(p, request.previous, request.requested);
					throw error;
				}
			});
			try {
				fireTodoFixPrompt(
					p,
					prepared.fixText,
					prepared.details,
					prepared.previous,
					prepared.requested,
					prepared.findings,
				);
			} catch (error) {
				if (prepared.findings.length > 0)
					rollbackSend(
						p.workspaceId,
						prepared.findings.map((c) => c.id),
						p.sessionId,
					);
				rollbackTodoFix(p, prepared.previous, prepared.requested);
				throw error;
			}
			return { ok: true } as const;
		} catch (error) {
			releaseItemFix(p.sessionId, p.id);
			throw error;
		}
	},
	"git.status": (p) => {
		void ensureWatch(p.workspaceId);
		return gitStatus(p.workspaceId, p.scope);
	},
	"git.diffFile": (p) => {
		void ensureWatch(p.workspaceId);
		return gitDiffFile(p.workspaceId, p.path, p.scope);
	},
	"git.listCommits": (params) => listCommits(params.workspaceId),
	"workspace.turns": (p) => {
		getWorkspace(p.workspaceId);
		return { turns: listTurns(p.workspaceId) };
	},
	"change.revert": (p) => {
		void ensureWatch(p.workspaceId);
		return withChangeLock(p.workspaceId, async () => ({ receipt: await revertChange(p) }));
	},
	"change.undo": (p) => {
		void ensureWatch(p.workspaceId);
		return withChangeLock(p.workspaceId, async () => ({ receipt: await undoChange(p) }));
	},
	"terminal.reserve": (p) => {
		getWorkspace(p.workspaceId);
		return { tab: reserveTerminal(p.workspaceId, p.tabKey, p.title) };
	},
	"terminal.attach": (p, ctx) => {
		return attachTerminal(p.workspaceId, p.tabKey, ctx.clientKey, p);
	},
	"terminal.list": (params) => ({
		tabs: listTerminals(params.workspaceId),
	}),
	"terminal.write": (p, ctx) => {
		const workspaceId = writeTerminal(p.id, p.data, ctx.clientKey);
		if (workspaceId) recordWorkspaceActivity(workspaceId);
		return { ok: true } as const;
	},
	"terminal.resize": (p, ctx) => {
		resizeTerminal(p.id, p.cols, p.rows, ctx.clientKey);
		return { ok: true } as const;
	},
	"terminal.close": (p) => {
		return closeTerminalTab(p.workspaceId, p.tabKey, p.force ?? false);
	},
	"skill.list": (params) => {
		const { projectId } = params;
		const project = listProjects().find((candidate) => candidate.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return listSkillCommands(project.path, admissionContextFor(project));
	},
	"skills.state": (params) => {
		const { workspaceId } = params;
		const ws = getWorkspace(workspaceId);
		const project = listProjects().find((p) => p.id === ws.projectId);
		return listSkillCatalog(ws.worktreePath, admissionContextFor(project, ws.skillOverrides ?? {}));
	},
	"extension.list": () => listExtensionCatalog(new Set(getConfig().disabledExtensions)),
	"locales.list": () => readLocalLocales(),
	"locales.reveal": () => {
		const dir = localesDir();
		mkdirSync(dir, { recursive: true });
		revealInFileManager(dir);
		return { ok: true } as const;
	},
	"project.acknowledgeSkills": (p) => {
		return acknowledgeProjectSkills(p.id, p.names);
	},
	"project.setSkillEnabled": (p) => {
		return setProjectSkillEnabled(p.id, p.name, p.enabled);
	},
	"project.aliasSkills": (params) => {
		const { projectId } = params;
		const project = listProjects().find((p) => p.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return listProjectAliasSkillNames(project.path);
	},
	"project.trustSummary": (params) => {
		const { projectId } = params;
		const project = listProjects().find((p) => p.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return projectTrustSummary(project.path);
	},
	"project.setGroupEnabled": (p) => {
		return setProjectGroupEnabled(p.id, p.group, p.enabled);
	},
	"project.skills": (params) => {
		const { projectId } = params;
		const project = listProjects().find((p) => p.id === projectId);
		if (!project) throw new Error(`Unknown project: ${projectId}`);
		return listSkillCatalog(project.path, admissionContextFor(project));
	},
	"workspace.setSkillOverride": (p) => {
		return setWorkspaceSkillOverride(p.id, p.name, p.override);
	},
	"workspace.setSubagentsOverride": (p) => {
		const workspace = setWorkspaceSubagentsOverride(p.id, p.override);
		refreshSubagentTools(p.id);
		return workspace;
	},
	"workspace.setSubagentMaxConcurrent": (p) => {
		const workspace = setWorkspaceSubagentMaxConcurrent(p.id, p.value);
		refreshSubagentConcurrency(p.id);
		return workspace;
	},
	"workspace.setDiffBase": (p) => {
		return setWorkspaceDiffBase(p.id, p.ref);
	},
	"workspace.watchReady": (p) => {
		return ensureWatch(p.workspaceId, { prewarm: p.prewarm === true });
	},
	"session.reloadResources": async (params) => {
		await reloadSessionResources(params.sessionId);
		return { ok: true } as const;
	},
	"session.create": async (p) => {
		const ws = getWorkspace(p.workspaceId);
		ensureWorkspaceScratchDir(ws);
		const defaults = await resolveNewChatModel(p);
		const created = await createSession({
			cwd: ws.worktreePath,
			workspaceId: p.workspaceId,
			...(defaults.model ? { model: defaults.model } : {}),
			thinkingLevel: defaults.thinkingLevel,
		});
		if (p.model && created.model) noteRecentModel(created.model);
		return created;
	},
	"session.prompt": (p, ctx) => {
		return sendUserMessage(p.text, ctx.clientKey, () =>
			promptSession(p.sessionId, p.text, p.images),
		);
	},
	"session.steer": (p, ctx) => {
		return sendUserMessage(p.text, ctx.clientKey, () =>
			steerSession(p.sessionId, p.text, p.images),
		);
	},
	"session.followUp": (p, ctx) => {
		return sendUserMessage(p.text, ctx.clientKey, () =>
			followUpSession(p.sessionId, p.text, p.images),
		);
	},
	"session.clearQueue": (p) => clearQueueSession(p.sessionId, p.requireTextOnly),
	"session.removeQueued": (p) => removeQueuedSession(p.sessionId, p.kind, p.index),
	"session.abort": async (p) => {
		const stopping = abortSession(p.sessionId, p.restoreQueue);
		const restoredQueue = await stopping;
		return {
			ok: true,
			...(restoredQueue ? { restoredQueue } : {}),
		} as const;
	},
	"session.dispose": async (params) => {
		const { sessionId } = params;
		await removeSession(sessionId);
		return { ok: true } as const;
	},
	"session.delete": async (p) => {
		await deleteSession(p.sessionId, p.workspaceId, getWorkspace(p.workspaceId).worktreePath);
		await removeSessionTodoWindows(p);
		return { ok: true } as const;
	},
	"session.rename": async (p) => {
		await renameSession(
			p.sessionId,
			p.workspaceId,
			getWorkspace(p.workspaceId).worktreePath,
			p.title,
		);
		return { ok: true } as const;
	},
	"session.setModel": async (p) => {
		noteRecentModel(await setSessionModel(p.sessionId, p.model));
		return { ok: true } as const;
	},
	"session.setThinkingLevel": (p) => {
		setSessionThinkingLevel(p.sessionId, p.level);
		return { ok: true } as const;
	},
	"session.compact": async (p) => {
		await compactSession(p.sessionId, p.instructions);
		return { ok: true } as const;
	},
	"session.getStats": (params) => getSessionStats(params.sessionId),
	"session.getCommands": (params) => getSessionCommands(params.sessionId),
	"session.list": async (params) => {
		const { workspaceId } = params;
		const summaries = await listSessions(workspaceId, getWorkspace(workspaceId).worktreePath);
		return summaries.map((summary) => {
			try {
				return {
					...summary,
					openTodos: countOpenTodos({ workspaceId, sessionId: summary.sessionId }),
				};
			} catch {
				return summary;
			}
		});
	},
	"session.stateList": () =>
		listSessionStates(listAllWorkspaceRecords().map(sessionStateWorkspace)),
	"session.acknowledgeCompletion": (p) => {
		return acknowledgeCompletion(p.sessionId, p.completionId);
	},
	"session.nudge": async (p) => {
		const workspace = getWorkspace(p.workspaceId);
		const attachedWorkspaceId = getSessionWorkspaceId(p.sessionId);
		if (
			(attachedWorkspaceId !== undefined && attachedWorkspaceId !== p.workspaceId) ||
			(attachedWorkspaceId === undefined &&
				!(await ensureSessionAttached(p.sessionId, p.workspaceId, workspace.worktreePath)))
		) {
			throw new Error(`Unknown session: ${p.sessionId}`);
		}
		if (!isControlMessage(p.text)) throw new Error("Session nudge must be a control message");
		const nudge = nudgeSession(p.sessionId, p.text, p.images);
		if (nudge.disposition !== "needs_input") {
			await ackSend(nudge.send());
		}
		return { disposition: nudge.disposition };
	},
	"session.activityList": () => [],
	"session.getMessages": (p) => {
		return getSessionMessages(p.sessionId, p.workspaceId, getWorkspace(p.workspaceId).worktreePath);
	},
	"mcp.list": (params) => mcpList(params),
	"mcp.add": (params) => mcpAdd(params),
	"mcp.update": (params) => mcpUpdate(params),
	"mcp.remove": (params) => mcpRemove(params),
	"mcp.setProjectOverride": (params) => mcpSetProjectOverride(params),
	"mcp.revokeToolGrant": (params) => mcpRevokeToolGrant(params),
	"mcp.setSessionOverride": (params) => mcpSetSessionOverride(params),
	"mcp.approve": (params) => mcpApprove(params),
	"mcp.shareWithRepo": (params) => mcpShareWithRepo(params),
	"mcp.reconnect": (params) => mcpReconnect(params),
	"mcp.login": (params, ctx) => mcpLogin(params, ctx.clientKey),
	"mcp.logout": (params, ctx) => mcpLogout(params, ctx.clientKey),
	"mcp.readOutput": (params) => mcpReadOutput(params),
	"mcp.readLog": (params) => mcpReadLog(params),
	"mcp.testConnection": (params, ctx) => mcpTestConnection(params, ctx.clientKey),
	"session.resources": (params) => {
		const p = resourceParams(params, ["workspaceId", "sessionId"]);
		return getSessionResources(p.workspaceId, p.sessionId, resourceCwd(p.workspaceId));
	},
	"backgroundCommand.output": (params) => {
		const p = resourceParams(params, ["workspaceId", "sessionId", "commandId"]);
		return readBackgroundCommandOutput(
			p.workspaceId,
			p.sessionId,
			p.commandId,
			resourceCwd(p.workspaceId),
		);
	},
	"backgroundCommand.stop": async (params) => {
		const p = resourceParams(params, ["workspaceId", "sessionId", "commandId"]);
		await stopBackgroundCommand(
			p.workspaceId,
			p.sessionId,
			p.commandId,
			resourceCwd(p.workspaceId),
		);
		return { ok: true } as const;
	},
	"subagent.stop": async (params) => {
		const p = resourceParams(params, ["workspaceId", "parentSessionId", "childSessionId"]);
		await stopSubagent(
			p.workspaceId,
			p.parentSessionId,
			p.childSessionId,
			resourceCwd(p.workspaceId),
		);
		return { ok: true } as const;
	},
	"subagent.stopAll": async (params) => {
		const p = resourceParams(params, ["workspaceId", "parentSessionId"]);
		const targeted = await stopAllSubagents(
			p.workspaceId,
			p.parentSessionId,
			resourceCwd(p.workspaceId),
		);
		return { ok: true, targeted } as const;
	},
	"subagent.getTranscript": (p) => {
		getWorkspace(p.workspaceId);
		return readChildTranscript(p.workspaceId, p.parentSessionId, p.childSessionId);
	},
	"session.extUiReply": (params) => {
		resolveExtUi(params.response);
		return { ok: true } as const;
	},
	"session.answerQuestion": async (p) => {
		if (!hasSession(p.sessionId)) throw new Error(`Unknown session: ${p.sessionId}`);
		if (!p.result || !Array.isArray(p.result.answers) || typeof p.result.cancelled !== "boolean")
			throw new Error("Malformed ask_user_question result");
		await ackSend(answerQuestion(p.sessionId, p.toolCallId, p.result));
		return { ok: true } as const;
	},
	"model.list": () => listAvailableModels(),
	"model.clampThinking": async (p) => {
		return { level: await clampThinkingForModel({ provider: p.provider, id: p.id }, p.level) };
	},
	"model.refresh": (p) => {
		return refreshAvailableModels(p.force === true);
	},
	"model.contextSettings": () => listModelContextSettings(),
	"model.setContextWindow": (p) => {
		return setModelContextWindow(p.target, p.contextWindow);
	},
	"model.default": () => resolveNewChatModel({}),
	"provider.status": () => getProviderStatus(),
	"provider.compatibleList": () => listCompatibleProviders(),
	"provider.compatibleSave": (p) => saveCompatibleProvider(p),
	"provider.compatibleDiscover": (p) => discoverCompatibleModels(p),
	"provider.compatibleRemove": async (p) => {
		await removeCompatibleProvider(p.id, p.revision);
		return { ok: true } as const;
	},
	"provider.loginStart": (p) => {
		const type = p.type ?? "oauth";
		const handle = startLogin(p.providerId, type);
		return handle;
	},
	"provider.loginReply": (reply, ctx) => {
		if (isMcpLoginId(reply.loginId)) replyMcpProbe(reply.loginId, ctx.clientKey, reply.value);
		else resolveLogin(reply);
		return { ok: true } as const;
	},
	"provider.loginCancel": (params, ctx) => {
		const { loginId } = params;
		if (isMcpLoginId(loginId)) {
			cancelMcpProbe(loginId, ctx.clientKey);
			return { ok: true } as const;
		}
		cancelLogin(loginId);
		return { ok: true } as const;
	},
	"provider.logout": async (params) => {
		await logoutProvider(params.providerId);
		return { ok: true } as const;
	},
	"provider.jbcentralConnect": () => connectJbcentral(),
	"provider.jbcentralDisconnect": () => disconnectJbcentral(),
	"provider.jbcentralStartProxy": () => startProxyJbcentral(),
	"provider.jbcentralLogin": () => jbcentralLogin(),
	"provider.jbcentralUpdate": () => updateJbcentral(),
	"provider.jbcentralQuota": (params) => {
		const config = getConfig();
		if (!config.jbcentralQuotaEnabled) return { state: "hidden" } as const;
		return getJbcentralQuota({
			maxAgeMs: config.jbcentralQuotaRefreshSeconds * 1000,
			force: params.force === true,
		});
	},
	"host.update": (_params, ctx) => {
		if (!ctx.runHostUpdate) throw new Error("Host update is unavailable.");
		ctx.runHostUpdate();
		return { ok: true } as const;
	},
	"settings.update": (params) => {
		const config = params.config;
		return updateConfig(config);
	},
	"feedback.respond": (params) => {
		respondToInterview(params.action);
		return { ok: true } as const;
	},
	"client.reportError": () => {
		return { ok: true } as const;
	},
	"history.search": (p) => {
		const { filter, labels } = buildHistoryScope(p.scope, listProjects(), (projectId) =>
			listWorkspaceRecords(projectId),
		);
		return getHistoryIndex().search({
			query: p.query,
			filter,
			labels,
			limit: clampLimit(p.limit),
		});
	},
	"review.get": async (p) => {
		ensureWatch(p.workspaceId);
		return markClientStale(await getReviewSnapshot(p.workspaceId), p.workspaceId);
	},
	"review.commentAdd": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			const comment = await addComment(p);
			return comment;
		});
	},
	"review.commentUpdate": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			const updated = await updateComment(p);
			// Resolving/dismissing the item's last open finding must clear its changes_requested verdict
			// too (no-op while findings remain), the same invariant as commentDelete.
			if (updated.origin?.todoId)
				await clearChangesRequestedIfResolved({
					workspaceId: p.workspaceId,
					sessionId: updated.origin.sessionId,
					id: updated.origin.todoId,
				});
			return updated;
		});
	},
	"review.commentDelete": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			const origin = (await getReviewSnapshot(p.workspaceId)).comments.find(
				(c) => c.id === p.id,
			)?.origin;
			await deleteComment(p.workspaceId, p.id);
			// A changes_requested verdict must not outlive its findings: if this was the item's last open
			// finding, drop the verdict back to unreviewed.
			if (origin?.todoId)
				await clearChangesRequestedIfResolved({
					workspaceId: p.workspaceId,
					sessionId: origin.sessionId,
					id: origin.todoId,
				});
			return { ok: true } as const;
		});
	},
	"review.fileDone": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			await markFileDone(p.workspaceId, p.path);
			return { ok: true } as const;
		});
	},
	"review.close": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			await clearReview(p.workspaceId);
			return { ok: true } as const;
		});
	},
	"review.sendComment": (p) => {
		return withReviewLock(p.workspaceId, async () =>
			sendToFileChat(p.workspaceId, await sendableComments(p.workspaceId, [p.id]), p),
		);
	},
	"review.sendBatch": (p) => {
		return withReviewLock(p.workspaceId, async () => {
			const comments = await sendableComments(p.workspaceId, p.commentIds);
			const sessions: ReviewSendResult[] = [];
			for (const group of reviewSendGroups(comments, p.sessionId)) {
				sessions.push(await sendToFileChat(p.workspaceId, group, p));
			}
			if (sessions.length === 0) throw new Error("No draft comments to send.");
			return { sessions };
		});
	},
	"template.list": (params) => ({
		templates: listTemplates(resolveTemplateReadDirs(params)),
	}),
	"template.get": (p) => {
		return getTemplate(resolveTemplateReadDirs(p), p.name, p.scope);
	},
	"template.save": (p) => {
		const dirs = templateDirs(p.workspaceId ? getWorkspace(p.workspaceId).worktreePath : undefined);
		return saveTemplate(dirs, p.scope, p.name, p.content);
	},
	"template.delete": (p) => {
		const dirs = templateDirs(p.workspaceId ? getWorkspace(p.workspaceId).worktreePath : undefined);
		deleteTemplate(dirs, p.scope, p.name);
		return { ok: true } as const;
	},
};
function isWsMethod(method: string): method is WsMethodName {
	return Object.hasOwn(handlers, method);
}
function dispatch<M extends WsMethodName>(method: M, params: WsParams<M>, ctx: RequestContext) {
	return handlers[method](params, ctx);
}
export function requestMethodDiagnostic(method: string): string {
	return isWsMethod(method) ? method : "unknown method";
}
function supportsBranchStatus(protocolVersion: number | undefined): boolean {
	return protocolVersion === undefined || protocolVersion >= BRANCH_STATUS_PROTOCOL_VERSION;
}
function requireBranchCleanup(ctx: RequestContext): void {
	if (ctx.protocolVersion === undefined || ctx.protocolVersion < BRANCH_CLEANUP_PROTOCOL_VERSION)
		throw new CodedError(
			"BRANCH_CLEANUP_UNSUPPORTED",
			"Local branch cleanup requires a newer host and client",
		);
}
export function shouldRefreshOpenReview(allowCached: boolean | undefined): boolean {
	return allowCached !== true;
}
export function openReviewForClient(
	review: OpenBranchReview | null,
	protocolVersion: number | undefined,
): OpenBranchReview | null {
	if (
		!review ||
		protocolVersion === undefined ||
		protocolVersion >= WORKSPACE_SETTLE_PROTOCOL_VERSION
	)
		return review;
	return review.state === undefined || review.state === "open" ? review : null;
}
export async function handleRequest(
	method: string,
	params: unknown,
	ctx: RequestContext,
): Promise<unknown> {
	if (!isWsMethod(method)) throw new Error(`Unknown method: ${method}`);
	return dispatch(method, params as WsParams<typeof method>, ctx);
}
