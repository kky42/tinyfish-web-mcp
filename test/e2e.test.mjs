// End-to-end: spawns the built server over stdio with a real MCP client and
// calls the real TinyFish APIs. Requires TINYFISH_API_KEY.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("web_search returns structured results that match the text", async () => {
	const result = await client.callTool({ name: "web_search", arguments: { query: "Node.js release schedule" } });
	const { results } = result.structuredContent;
	assert.ok(results.length > 0);
	assert.match(results[0].url, /^https?:\/\//);
	assert.ok(text(result).includes(results[0].url));
});

test("web_search applies array domain filters and the recency enum", async () => {
	const result = await client.callTool({
		name: "web_search",
		arguments: { query: "release notes", include_domains: ["github.com", "nodejs.org"], recency: "year" },
	});
	assert.ok(!result.isError, text(result));
	const { results } = result.structuredContent;
	assert.ok(results.length > 0);
	assert.ok(results.every((r) => /(^|\.)(github\.com|nodejs\.org)$/.test(new URL(r.url).hostname)));
});

test("web_fetch saves a long page and points to it with a line-numbered outline", async () => {
	const result = await client.callTool({ name: "web_fetch", arguments: { urls: [LONG_DOC] } });
	const note = text(result).match(/Full markdown saved to (\S+\.md)/);
	assert.ok(note, "long page should name its saved file");
	assert.match(text(result), /Outline \(line: heading\):\n\s+\d+: #/);

	const [page] = result.structuredContent.pages;
	const saved = (await readFile(note[1], "utf8")).split("\n");
	assert.equal(page.truncated.path, note[1]);
	assert.equal(saved.length, page.truncated.total_lines);
	assert.equal(page.text, saved.slice(0, page.truncated.shown_lines).join("\n"));
	for (const h of page.truncated.outline) assert.ok(saved[h.line - 1].includes(h.title));
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

test("web_fetch structured pages mark only long pages as truncated", async () => {
	const result = await client.callTool({ name: "web_fetch", arguments: { urls: [LONG_DOC, "https://example.com"] } });
	const [long, short] = result.structuredContent.pages;
	assert.equal(long.url, LONG_DOC);
	assert.ok(long.truncated && long.text.length < long.total_chars);
	assert.equal(short.truncated, undefined);
	assert.equal(short.text.length, short.total_chars);
});

test("web_fetch is an error only when every URL fails", async () => {
	const result = await client.callTool({ name: "web_fetch", arguments: { urls: ["https://nonexistent.invalid"] } });
	assert.equal(result.isError, true);
	assert.match(text(result), /✗ https:\/\/nonexistent\.invalid/);
});

test("invalid arguments are rejected before any request", async () => {
	const result = await client.callTool({ name: "web_fetch", arguments: { urls: [] } });
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
