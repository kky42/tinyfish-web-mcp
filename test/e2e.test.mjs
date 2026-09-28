// End-to-end: spawns the built server over stdio with a real MCP client and
// calls the real TinyFish APIs. Requires TINYFISH_API_KEY.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const SERVER = new URL("../dist/index.js", import.meta.url).pathname;
const LONG_DOC = "https://docs.python.org/3/library/asyncio-task.html";

async function connect(env) {
	const client = new Client({ name: "e2e", version: "0" });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env }));
	return client;
}

const text = (result) => result.content.map((c) => c.text ?? "").join("");

let client;
before(async () => {
	assert.ok(process.env.TINYFISH_API_KEY, "TINYFISH_API_KEY must be set");
	client = await connect({ PATH: process.env.PATH, TINYFISH_API_KEY: process.env.TINYFISH_API_KEY });
});
after(() => client?.close());

test("lists exactly the two tools", async () => {
	const { tools } = await client.listTools();
	assert.deepEqual(tools.map((t) => t.name).sort(), ["web_fetch", "web_search"]);
});

test("web_search returns ranked results with URLs", async () => {
	const result = await client.callTool({ name: "web_search", arguments: { query: "Node.js release schedule" } });
	assert.ok(!result.isError, text(result));
	assert.match(text(result), /^1\. .+\n(?:.*\n)*?\s+https?:\/\//m);
});

test("web_fetch continues a long document from the offset in its header note", async () => {
	const first = text(await client.callTool({ name: "web_fetch", arguments: { urls: [LONG_DOC] } }));
	const next = first.match(/and offset (\d+)\]/);
	assert.ok(next, "long page should end with a continuation note");

	const second = text(
		await client.callTool({ name: "web_fetch", arguments: { urls: [LONG_DOC], offset: Number(next[1]) } }),
	);
	assert.match(second, new RegExp(`showing chars ${next[1]}–\\d+ of \\d+`));
});

test("web_fetch reports per-URL failures without failing the call", async () => {
	const result = await client.callTool({
		name: "web_fetch",
		arguments: { urls: ["https://example.com", "https://nonexistent.invalid"] },
	});
	assert.ok(!result.isError, text(result));
	assert.match(text(result), /— https:\/\/example\.com/);
	assert.match(text(result), /✗ https:\/\/nonexistent\.invalid/);
});

test("invalid arguments are rejected before any request", async () => {
	const result = await client.callTool({ name: "web_fetch", arguments: { urls: [], offset: -1 } });
	assert.equal(result.isError, true);
});

test("a missing API key surfaces as a tool error", async () => {
	const keyless = await connect({ PATH: process.env.PATH });
	try {
		const result = await keyless.callTool({ name: "web_search", arguments: { query: "x" } });
		assert.equal(result.isError, true);
		assert.match(text(result), /TINYFISH_API_KEY/);
	} finally {
		await keyless.close();
	}
});
