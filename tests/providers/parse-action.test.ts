import { describe, expect, it } from "bun:test";
import { OutputError } from "../../src/errors";
import { parseActionFromJson } from "../../src/providers/parse-action";

describe("action response parsing", () => {
	it("parses ordinary JSON actions", () => {
		expect(parseActionFromJson('{"tool":"dock","params":{}}')).toEqual({ tool: "dock", params: {} });
	});

	it("normalizes a DeepSeek DSML tool call", () => {
		const raw = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="view_market">
<｜DSML｜parameter name="item_id" string="true">iron_ore</｜DSML｜parameter>
<｜DSML｜parameter name="quantity" string="false">15</｜DSML｜parameter>
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;

		expect(parseActionFromJson(raw)).toEqual({
			tool: "view_market",
			params: { item_id: "iron_ore", quantity: 15 },
		});
	});

	it("normalizes a parameterless DeepSeek DSML tool call", () => {
		const raw = `<｜DSML｜tool_calls>
<｜DSML｜invoke name="undock">
</｜DSML｜invoke>
</｜DSML｜tool_calls>`;
		expect(parseActionFromJson(raw)).toEqual({ tool: "undock", params: {} });
	});

	it("rejects malformed or multiple DSML calls", () => {
		expect(() => parseActionFromJson("<｜DSML｜invoke name=bad>"))
			.toThrow(OutputError);
		const call = '<｜DSML｜invoke name="dock"></｜DSML｜invoke>';
		expect(() => parseActionFromJson(`${call}${call}`)).toThrow(OutputError);
	});
});
