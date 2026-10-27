import { expect, test } from "bun:test";
import { applyLocale } from "@thinkrail/locales/react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompatibleProviderForm } from "./CompatibleProvidersSettings";

test("preset pre-fills editable routing without a key, models or no-key mode", () => {
	const markup = renderToStaticMarkup(
		<CompatibleProviderForm
			initialValues={{
				name: "玲珑AI",
				baseUrl: "https://www.llaigw.com/v1",
				api: "openai-completions",
			}}
			onSave={async () => {}}
			onCancel={() => {}}
		/>,
	);
	expect(markup).toContain('value="玲珑AI"');
	expect(markup).toContain('value="https://www.llaigw.com/v1"');
	expect(markup).toContain('value="openai-completions" selected=""');
	expect(markup).toMatch(/data-testid="compatible-key"[^>]*value=""/);
	expect(markup).toMatch(/data-testid="compatible-model-id"[^>]*value=""/);
	expect(markup).toContain('aria-checked="false"');
	expect(markup).toMatch(/data-testid="compatible-save"[^>]*disabled=""/);
});

test("ordinary new service keeps blank routing and explicit no-key mode", () => {
	const markup = renderToStaticMarkup(
		<CompatibleProviderForm onSave={async () => {}} onCancel={() => {}} />,
	);
	expect(markup).toMatch(/data-testid="compatible-name"[^>]*value=""/);
	expect(markup).toMatch(/data-testid="compatible-url"[^>]*value=""/);
	expect(markup).toContain('value="openai-completions" selected=""');
	expect(markup).toContain('aria-checked="true"');
	expect(markup).not.toContain('data-testid="compatible-key"');
});

test("Chinese service form renders owned labels, password field and no saved secret", () => {
	applyLocale("zh-CN", {});
	try {
		const markup = renderToStaticMarkup(
			<CompatibleProviderForm
				initialValues={{
					name: "Unused preset",
					baseUrl: "https://example.com/v1",
					api: "openai-completions",
				}}
				provider={{
					id: "fixture-id",
					revision: "fixture-revision",
					name: "本地服务",
					baseUrl: "http://localhost:1234/v1",
					api: "openai-responses",
					models: [{ id: "local-model" }],
					hasKey: true,
				}}
				onSave={async () => {}}
				onCancel={() => {}}
			/>,
		);
		expect(markup).toContain("服务名称");
		expect(markup).toContain("模型高级设置");
		expect(markup).toContain('type="password"');
		expect(markup).toContain("留空保留已保存的 Key");
		expect(markup).toContain('value="本地服务"');
		expect(markup).toContain('value="http://localhost:1234/v1"');
		expect(markup).toContain('value="openai-responses" selected=""');
		expect(markup).toContain('value="local-model"');
		expect(markup).not.toContain("Unused preset");
		expect(markup).not.toContain("fixture-revision");
	} finally {
		applyLocale("en", {});
	}
});
