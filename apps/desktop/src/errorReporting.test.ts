import { expect, spyOn, test } from "bun:test";
import { desktopError } from "./errorReporting";

test("desktop errors remain local and do not interrupt recovery", () => {
	const output = spyOn(console, "error").mockImplementation(() => {});
	try {
		const error = new Error("boom");
		desktopError("updates", "update lifecycle failed", error);
		desktopError("preferences", "could not save a local preference");
		expect(output).toHaveBeenCalledWith("[desktop] update lifecycle failed", error);
		expect(output).toHaveBeenCalledTimes(2);
	} finally {
		output.mockRestore();
	}
});
