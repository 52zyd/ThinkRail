import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { CompatibleProvider, CompatibleProviderInput } from "@thinkrail/contracts";
import { CodedError } from "@thinkrail/shared/codedError";
import { parse } from "jsonc-parser";
import {
	createSession,
	removeSession,
	setSessionManagerFactory,
	toWireModel,
} from "./agentSessionManager";
import {
	discoverCompatibleModels,
	listCompatibleProviders,
	removeCompatibleProvider,
	saveCompatibleProvider,
} from "./compatibleProviders";
import { delegationServiceFor, hasProviderChildren } from "./delegation";
import { writeModelsFile } from "./modelsConfig";
import {
	activatePiRuntimeGeneration,
	configurePiRuntime,
	getPiRuntimeGeneration,
} from "./piRuntime";
import { reserveModelProvider, withProviderWrite } from "./providerAdmission";

let directory: string;
let previous: string | undefined;
let previousOffline: string | undefined;
let runtime: ModelRuntime;
const servers: ReturnType<typeof Bun.serve>[] = [];
const draft: CompatibleProviderInput = {
	name: "Local service",
	baseUrl: "http://127.0.0.1:12345/v1",
	api: "openai-completions",
	models: [{ id: "local-model" }],
};

beforeEach(async () => {
	directory = mkdtempSync(join(tmpdir(), "thinkrail-compatible-"));
	previous = process.env.PI_CODING_AGENT_DIR;
	previousOffline = process.env.PI_OFFLINE;
	process.env.PI_CODING_AGENT_DIR = directory;
	process.env.PI_OFFLINE = "1";
	runtime = await ModelRuntime.create({ allowModelNetwork: false });
	configurePiRuntime(runtime);
});

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	configurePiRuntime(null);
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	if (previousOffline === undefined) delete process.env.PI_OFFLINE;
	else process.env.PI_OFFLINE = previousOffline;
	rmSync(directory, { recursive: true, force: true });
});

function edit(provider: CompatibleProvider): CompatibleProviderInput {
	const { hasKey: _hasKey, ...input } = provider;
	return input;
}

function serve(fetch: (request: Request) => Response | Promise<Response>): string {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 30, fetch });
	servers.push(server);
	return `${server.url.toString().replace(/\/$/, "")}/custom/v1`;
}

async function code(operation: () => unknown): Promise<string | undefined> {
	try {
		await operation();
		return undefined;
	} catch (error) {
		return error instanceof CodedError ? error.code : undefined;
	}
}

test("multiple services and literal keys persist through pi without leaking onto descriptors or models", async () => {
	const literal = `!not-a-command-\${NOT_AN_ENV_VAR}`;
	const first = await saveCompatibleProvider({ ...draft, apiKey: literal });
	const second = await saveCompatibleProvider({
		...draft,
		name: "Responses",
		api: "openai-responses",
		apiKey: null,
	});
	expect(first.id).not.toBe(second.id);
	expect(first.hasKey).toBe(true);
	expect(second.hasKey).toBe(false);
	expect((await runtime.getAuth(first.id))?.auth.apiKey).toBe(literal);
	expect(readFileSync(join(directory, "models.json"), "utf8")).not.toContain(literal);
	expect(JSON.stringify(await listCompatibleProviders())).not.toContain(literal);
	runtime = await ModelRuntime.create({ allowModelNetwork: false });
	configurePiRuntime(runtime);
	expect((await listCompatibleProviders()).map((p) => p.id)).toEqual([first.id, second.id]);
	expect((await runtime.getAuth(first.id))?.auth.apiKey).toBe(literal);
	const model = runtime.getAvailableSnapshot().find((m) => m.provider === first.id);
	if (!model) throw new Error("Fixture model missing");
	expect(model.contextWindow).toBe(128000);
	expect(model.maxTokens).toBe(16384);
	expect(toWireModel(model)).not.toHaveProperty("baseUrl");
	expect(toWireModel(model)).not.toHaveProperty("cost");
});

test("blank edit retains a key, replacement is literal, explicit no-key clears credentials, deletion removes only its service", async () => {
	const provider = await saveCompatibleProvider({ ...draft, apiKey: "first-key" });
	const other = await saveCompatibleProvider({ ...draft, name: "Other" });
	const saved = await saveCompatibleProvider({ ...edit(provider), name: "Renamed" });
	expect((await runtime.getAuth(saved.id))?.auth.apiKey).toBe("first-key");
	const replaced = await saveCompatibleProvider({ ...edit(saved), apiKey: "second-key" });
	expect((await runtime.getAuth(replaced.id))?.auth.apiKey).toBe("second-key");
	const cleared = await saveCompatibleProvider({ ...edit(replaced), apiKey: null });
	expect(cleared.hasKey).toBe(false);
	expect((await runtime.listCredentials()).some((c) => c.providerId === cleared.id)).toBe(false);
	await removeCompatibleProvider(cleared.id, cleared.revision);
	expect((await listCompatibleProviders()).map((p) => p.id)).toEqual([other.id]);
	expect(runtime.getModels(cleared.id)).toEqual([]);
});

test("JSONC comments, BOM, unrelated providers and extra model fields survive concurrent saves", async () => {
	const path = join(directory, "models.json");
	writeFileSync(
		path,
		'\uFEFF{\n// keep this\n"providers":{"openai":{"apiKey":"external-secret",}},}\n',
	);
	const [a, b] = await Promise.all([
		saveCompatibleProvider(draft),
		saveCompatibleProvider({ ...draft, name: "B" }),
	]);
	const source = readFileSync(path, "utf8");
	expect(source.startsWith("\uFEFF")).toBe(true);
	expect(source).toContain("// keep this");
	expect(source).toContain("external-secret");
	expect((await listCompatibleProviders()).map((p) => p.id)).toEqual([a.id, b.id]);
	const json = parse(source.replace(/^\uFEFF/, ""), [], { allowTrailingComma: true });
	json.providers[a.id].models[0].samplingParams = { temperature: 0.4 };
	json.providers[a.id].models[0].baseUrl = "http://old-model-route.invalid";
	json.providers[a.id].models[0].api = "openai-responses";
	json.providers[a.id].modelOverrides = {
		"local-model": { contextWindow: 16_000, headers: { Authorization: "Bearer old-key" } },
	};
	writeFileSync(path, JSON.stringify(json));
	writeFileSync(
		path,
		readFileSync(path, "utf8").replace('"samplingParams"', '// model comment\n"samplingParams"'),
	);
	const fresh = (await listCompatibleProviders()).find((p) => p.id === a.id);
	if (!fresh) throw new Error("Fixture missing");
	expect(fresh.models[0]?.contextWindow).toBe(16_000);
	await saveCompatibleProvider({
		...edit(fresh),
		models: [
			{
				id: "local-model",
				maxTokens: 2000,
				contextWindow: 8000,
				reasoning: true,
				imageInput: true,
			},
		],
	});
	expect(parse(readFileSync(path, "utf8")).providers[a.id].models[0]).toMatchObject({
		samplingParams: { temperature: 0.4 },
		maxTokens: 2000,
	});
	const model = runtime.getModel(a.id, "local-model");
	if (!model) throw new Error("Fixture model missing");
	expect(model?.input).toEqual(["text", "image"]);
	expect(model?.reasoning).toBe(true);
	expect(model?.baseUrl).toBe(draft.baseUrl);
	expect(model?.api).toBe(draft.api);
	expect(model?.contextWindow).toBe(8000);
	expect((await runtime.getAuth(model))?.auth.headers?.Authorization).toBeUndefined();
	expect(readFileSync(path, "utf8")).toContain("// model comment");
	const next = (await listCompatibleProviders()).find((provider) => provider.id === a.id);
	if (!next) throw new Error("Fixture missing");
	await saveCompatibleProvider({ ...edit(next), api: "openai-responses" });
	expect(readFileSync(path, "utf8")).toContain("// model comment");
});

test("an opaque extension cannot expose or edit a managed provider's credentials", async () => {
	const provider = await saveCompatibleProvider({ ...draft, apiKey: "private-key" });
	activatePiRuntimeGeneration({
		...(await getPiRuntimeGeneration()),
		opaqueProviderIds: new Set([provider.id]),
	});
	expect(await listCompatibleProviders()).toEqual([]);
	expect(await code(() => saveCompatibleProvider(edit(provider)))).toBe("COMPATIBLE_INVALID");
	expect(await code(() => removeCompatibleProvider(provider.id, provider.revision))).toBe(
		"COMPATIBLE_INVALID",
	);
	expect(
		await code(() => discoverCompatibleModels({ id: provider.id, baseUrl: provider.baseUrl })),
	).toBe("COMPATIBLE_DISCOVERY_FAILED");
});

test("stale revisions, invalid files and external edits are refused without overwriting", async () => {
	const provider = await saveCompatibleProvider(draft);
	await saveCompatibleProvider({ ...edit(provider), name: "Changed" });
	expect(await code(() => saveCompatibleProvider(edit(provider)))).toBe("COMPATIBLE_STALE");
	expect(await code(() => removeCompatibleProvider(provider.id, provider.revision))).toBe(
		"COMPATIBLE_STALE",
	);
	const path = join(directory, "models.json");
	const before = readFileSync(path, "utf8");
	writeFileSync(path, "{broken}");
	expect(await code(() => saveCompatibleProvider(draft))).toBe("COMPATIBLE_CONFIG_FAILED");
	expect(readFileSync(path, "utf8")).toBe("{broken}");
	expect(await code(() => writeModelsFile(path, before, before))).toBe("COMPATIBLE_STALE");
	expect(readFileSync(path, "utf8")).toBe("{broken}");
	const invalidSchema = '{"providers":{"broken":{"models":"not-an-array"}}}';
	writeFileSync(path, invalidSchema);
	expect(await code(() => saveCompatibleProvider(draft))).toBe("COMPATIBLE_CONFIG_FAILED");
	expect(readFileSync(path, "utf8")).toBe(invalidSchema);
});

test("invalid URLs, protocol, IDs, limits and keys cannot change configuration", async () => {
	for (const patch of [
		{ baseUrl: "file:///tmp/file" },
		{ baseUrl: "https://user:password@example.com/v1" },
		{ baseUrl: "https://example.com/v1?key=secret" },
		{ baseUrl: "http://host/v1/responses" },
		{ id: "openai" },
		{ models: [] },
		{ models: [{ id: "same" }, { id: "same" }] },
		{ models: [{ id: "test", contextWindow: 100, maxTokens: 200 }] },
		{ apiKey: "secret\r\nheader" },
	])
		expect(await code(() => saveCompatibleProvider({ ...draft, ...patch }))).toBe(
			"COMPATIBLE_INVALID",
		);
	expect(await listCompatibleProviders()).toEqual([]);
});

test("provider reservations fence saves, removals and new admission", async () => {
	const provider = await saveCompatibleProvider(draft);
	const release = reserveModelProvider(provider.id);
	try {
		expect(await code(() => saveCompatibleProvider(edit(provider)))).toBe("COMPATIBLE_IN_USE");
		expect(await code(() => removeCompatibleProvider(provider.id, provider.revision))).toBe(
			"COMPATIBLE_IN_USE",
		);
	} finally {
		release();
	}
	await withProviderWrite(
		provider.id,
		() => {},
		async () => {
			expect(() => reserveModelProvider(provider.id)).toThrow(
				"Provider configuration is being updated",
			);
		},
	);
});

test("a child using the service protects it even when its parent uses a different provider", async () => {
	const data = process.env.THINKRAIL_DATA_DIR;
	process.env.THINKRAIL_DATA_DIR = join(directory, "host");
	setSessionManagerFactory((cwd) => SessionManager.inMemory(cwd));
	let sessionId: string | undefined;
	try {
		const provider = await saveCompatibleProvider(draft);
		runtime.registerProvider("compatible-fixture-parent", {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1:1/v1",
			apiKey: "fixture-only",
			models: [
				{
					id: "parent",
					name: "Fixture parent",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 4096,
				},
			],
		});
		await runtime.refresh({ allowNetwork: false });
		const parentModel = runtime.getModel("compatible-fixture-parent", "parent");
		if (!parentModel) throw new Error("Missing parent model");
		const parent = await createSession({
			workspaceId: "compatible-child-test",
			cwd: directory,
			model: toWireModel(parentModel),
		});
		sessionId = parent.sessionId;
		const child = await delegationServiceFor("compatible-child-test").createChild({
			parent: sessionId,
			visibility: "hidden",
			info: { createdBy: "fixture" },
			session: { model: { provider: provider.id, id: "local-model" } },
		});
		expect(hasProviderChildren("compatible-child-test", sessionId, provider.id)).toBe(true);
		expect(await code(() => removeCompatibleProvider(provider.id, provider.revision))).toBe(
			"COMPATIBLE_IN_USE",
		);
		expect(await code(() => saveCompatibleProvider(edit(provider)))).toBe("COMPATIBLE_IN_USE");
		await child.dispose();
		expect(hasProviderChildren("compatible-child-test", sessionId, provider.id)).toBe(false);
		await removeCompatibleProvider(provider.id, provider.revision);
	} finally {
		if (sessionId) await removeSession(sessionId);
		setSessionManagerFactory((cwd) => SessionManager.create(cwd));
		if (data === undefined) delete process.env.THINKRAIL_DATA_DIR;
		else process.env.THINKRAIL_DATA_DIR = data;
	}
});

test("routing changes get a new identity so stale runtimes cannot send a replacement key to the old endpoint", async () => {
	const old = await saveCompatibleProvider({ ...draft, apiKey: "old-endpoint-key" });
	const staleRuntime = await ModelRuntime.create({ allowModelNetwork: false });
	const changed = await saveCompatibleProvider({
		...edit(old),
		baseUrl: "http://127.0.0.1:12346/v1",
		apiKey: "new-endpoint-key",
	});
	expect(changed.id).not.toBe(old.id);
	expect((await runtime.getAuth(changed.id))?.auth.apiKey).toBe("new-endpoint-key");
	expect(await staleRuntime.getAuth(old.id)).toBeUndefined();
	const retained = await saveCompatibleProvider({ ...edit(changed), api: "openai-responses" });
	expect((await runtime.getAuth(retained.id))?.auth.apiKey).toBe("new-endpoint-key");
	expect((await listCompatibleProviders()).map((p) => p.id)).toEqual([retained.id]);
});

test("blank edits preserve no-key mode after routing changes and restart", async () => {
	const observed: { auth: string | null } = { auth: null };
	const url = serve((request) => {
		observed.auth = request.headers.get("Authorization");
		return Response.json({ data: [{ id: "local-model" }] });
	});
	const old = await saveCompatibleProvider({ ...draft, apiKey: null });
	const changed = await saveCompatibleProvider({ ...edit(old), baseUrl: url });
	expect(changed.id).not.toBe(old.id);
	expect(changed.hasKey).toBe(false);
	expect((await runtime.listCredentials()).some((c) => c.providerId === changed.id)).toBe(false);
	runtime = await ModelRuntime.create({ allowModelNetwork: false });
	configurePiRuntime(runtime);
	expect((await listCompatibleProviders())[0]?.hasKey).toBe(false);
	expect(await discoverCompatibleModels({ id: changed.id, baseUrl: url })).toEqual(["local-model"]);
	expect(observed.auth).toBeNull();
});

test("discovery uses the supplied base path and saved key, deduplicates IDs and never leaks response bodies", async () => {
	const observed: { auth: string | null } = { auth: null };
	const url = serve((request) => {
		expect(new URL(request.url).pathname).toBe("/custom/v1/models");
		observed.auth = request.headers.get("Authorization");
		return Response.json({ data: [{ id: "z" }, { id: "a" }, { id: "a" }] });
	});
	const provider = await saveCompatibleProvider({
		...draft,
		baseUrl: url,
		apiKey: "fixture-secret",
	});
	expect(await discoverCompatibleModels({ id: provider.id, baseUrl: url })).toEqual(["a", "z"]);
	expect(observed.auth).toBe("Bearer fixture-secret");
	const literal = await saveCompatibleProvider({ ...edit(provider), apiKey: "thinkrail-no-auth" });
	await discoverCompatibleModels({ id: literal.id, baseUrl: url });
	expect(observed.auth).toBe("Bearer thinkrail-no-auth");
	expect(
		await code(() =>
			discoverCompatibleModels({ id: provider.id, baseUrl: "http://127.0.0.1:12345/v1" }),
		),
	).toBe("COMPATIBLE_INVALID");
	const bad = serve(() => new Response("secret-response-body", { status: 401 }));
	expect(
		await code(() => discoverCompatibleModels({ baseUrl: bad, apiKey: "fixture-secret" })),
	).toBe("COMPATIBLE_DISCOVERY_FAILED");
	const malformed = serve(() => Response.json({ data: [{ id: 123 }] }));
	expect(await code(() => discoverCompatibleModels({ baseUrl: malformed }))).toBe(
		"COMPATIBLE_DISCOVERY_FAILED",
	);
});

test("discovery refuses redirects and bounds response size", async () => {
	let targetReached = false;
	const target = serve(() => {
		targetReached = true;
		return Response.json({ data: [] });
	});
	const redirect = serve(() => Response.redirect(`${target}/models`, 302));
	expect(
		await code(() => discoverCompatibleModels({ baseUrl: redirect, apiKey: "fixture-secret" })),
	).toBe("COMPATIBLE_DISCOVERY_FAILED");
	expect(targetReached).toBe(false);
	const huge = serve(() => new Response("x".repeat(1_048_577)));
	expect(await code(() => discoverCompatibleModels({ baseUrl: huge }))).toBe(
		"COMPATIBLE_DISCOVERY_FAILED",
	);
});

test("model discovery times out without exposing remote content", async () => {
	const url = serve(async () => {
		await Bun.sleep(16_000);
		return Response.json({ data: [] });
	});
	expect(await code(() => discoverCompatibleModels({ baseUrl: url }))).toBe(
		"COMPATIBLE_DISCOVERY_FAILED",
	);
}, 20_000);

for (const api of ["openai-completions", "openai-responses"] as const) {
	test(`${api}: pi reports authentication, wrong-protocol and timeout failures without switching routes`, async () => {
		for (const failure of ["auth", "protocol", "timeout"] as const) {
			const paths: string[] = [];
			const url = serve(async (request) => {
				paths.push(new URL(request.url).pathname);
				if (failure === "timeout") await Bun.sleep(1_500);
				return Response.json(
					failure === "auth"
						? { error: { message: "Fixture authentication failure" } }
						: { wrong: true },
					{ status: failure === "auth" ? 401 : 200 },
				);
			});
			const provider = await saveCompatibleProvider({ ...draft, baseUrl: url, api });
			const model = runtime.getModel(provider.id, "local-model");
			if (!model) throw new Error("Missing fixture model");
			const result = await runtime
				.streamSimple(
					model,
					{
						messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
					},
					{ maxRetries: 0, timeoutMs: 1_000, signal: AbortSignal.timeout(1_000) },
				)
				.result();
			expect(result.stopReason).toBeOneOf(["error", "aborted"]);
			expect(paths).toEqual([
				`/custom/v1/${api === "openai-completions" ? "chat/completions" : "responses"}`,
			]);
		}
	});
	test(`${api}: real pi streaming reaches the configured URL with credentials, text and tool calls`, async () => {
		const url = serve(async (request) => {
			expect(new URL(request.url).pathname).toBe(
				`/custom/v1/${api === "openai-completions" ? "chat/completions" : "responses"}`,
			);
			expect(request.headers.get("Authorization")).toBe("Bearer sdk-fixture-key");
			const body = await request.json();
			expect(body.model).toBe("local-model");
			expect(body.stream).toBe(true);
			expect(body.tools).toEqual(
				expect.arrayContaining([
					expect.objectContaining(
						api === "openai-completions"
							? { function: expect.objectContaining({ name: "read" }) }
							: { name: "read" },
					),
				]),
			);
			const tool = {
				id: "call_fixture",
				type: "function",
				function: { name: "read", arguments: '{"path":"test.txt"}' },
			};
			const events =
				api === "openai-completions"
					? [
							`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "Hello", tool_calls: [{ index: 0, ...tool }] }, finish_reason: null }] })}\n\n`,
							`data: ${JSON.stringify({ id: "fixture", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
							"data: [DONE]\n\n",
						]
					: [
							{
								type: "response.created",
								response: { id: "resp_fixture", model: "local-model", status: "in_progress" },
							},
							{
								type: "response.output_item.added",
								output_index: 0,
								item: { type: "message", id: "msg_fixture", role: "assistant", content: [] },
							},
							{
								type: "response.content_part.added",
								output_index: 0,
								content_index: 0,
								part: { type: "output_text", text: "", annotations: [] },
							},
							{
								type: "response.output_text.delta",
								output_index: 0,
								content_index: 0,
								delta: "Hello",
							},
							{
								type: "response.output_item.done",
								output_index: 0,
								item: {
									type: "message",
									id: "msg_fixture",
									content: [{ type: "output_text", text: "Hello", annotations: [] }],
								},
							},
							{
								type: "response.output_item.added",
								output_index: 1,
								item: {
									type: "function_call",
									id: "fc_fixture",
									call_id: "call_fixture",
									name: "read",
									arguments: "",
								},
							},
							{
								type: "response.function_call_arguments.delta",
								output_index: 1,
								delta: '{"path":"test.txt"}',
							},
							{
								type: "response.output_item.done",
								output_index: 1,
								item: {
									type: "function_call",
									id: "fc_fixture",
									call_id: "call_fixture",
									name: "read",
									arguments: '{"path":"test.txt"}',
								},
							},
							{
								type: "response.completed",
								response: {
									id: "resp_fixture",
									status: "completed",
									usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
								},
							},
						].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			return new Response(events.join(""), { headers: { "Content-Type": "text/event-stream" } });
		});
		const provider = await saveCompatibleProvider({
			...draft,
			baseUrl: url,
			api,
			apiKey: "sdk-fixture-key",
			models: [{ id: "local-model", maxTokens: 64 }],
		});
		const model = runtime.getModel(provider.id, "local-model");
		if (!model) throw new Error("Missing fixture model");
		const stream = runtime.streamSimple(model, {
			messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			tools: [
				{
					name: "read",
					description: "Read a fixture",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			],
		});
		const types: string[] = [];
		for await (const event of stream) types.push(event.type);
		const result = await stream.result();
		expect(result.errorMessage).toBeUndefined();
		expect(types).toContain("text_delta");
		expect(result.content.some((block) => block.type === "text" && block.text === "Hello")).toBe(
			true,
		);
		expect(
			result.content.some(
				(block) =>
					block.type === "toolCall" && block.name === "read" && block.arguments.path === "test.txt",
			),
		).toBe(true);
		expect(result.stopReason).toBe("toolUse");
	});
}
