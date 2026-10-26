import { expect, test } from "bun:test";
import { applyLocale } from "@thinkrail/locales/react";
import { renderToStaticMarkup } from "react-dom/server";
import { CompatibleProviderForm } from "./CompatibleProvidersSettings";

test("Chinese service form renders owned labels, password field and no saved secret", () => {
	applyLocale("zh-CN", {});
	try {
		const markup = renderToStaticMarkup(
			<CompatibleProviderForm
				provider={{
					id: "fixture-id",
					revision: "fixture-revision",
					name: "本地服务",
					baseUrl: "http://localhost:1234/v1",
					api: "openai-completions",
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
		expect(markup).not.toContain("fixture-revision");
	} finally {
		applyLocale("en", {});
	}
});
