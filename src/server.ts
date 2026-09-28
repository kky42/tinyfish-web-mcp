import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { FETCH_WINDOW, fetchPages, search } from "./tinyfish.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export function createServer(): McpServer {
	const server = new McpServer({ name: "tinyfish-web", version });

	server.registerTool(
		"web_search",
		{
			title: "Web Search",
			description:
				"Search the live web. Returns up to 10 ranked results (title, URL, snippet; plus date and publisher for news, authors/venue/citations for papers). Use it to find URLs, then read them with web_fetch.",
			inputSchema: z.object({
				query: z.string().min(1).describe("Search keywords. Supports site: and -site: operators."),
				purpose: z.string().optional().describe("One sentence on why you're searching; improves ranking."),
				domain_type: z
					.enum(["web", "news", "research_paper"])
					.optional()
					.describe("Result type (default web)."),
				recency_minutes: z
					.number()
					.int()
					.min(1)
					.max(5_256_000)
					.optional()
					.describe("Only results from the last N minutes (e.g. 1440 = 1 day, 10080 = 1 week)."),
				include_domains: z
					.string()
					.optional()
					.describe("Comma-separated domains to limit results to, e.g. github.com,arxiv.org."),
				exclude_domains: z
					.string()
					.optional()
					.describe("Comma-separated domains to exclude, e.g. pinterest.com,quora.com."),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (params, ctx) => ({
			content: [{ type: "text", text: await search(params, ctx.mcpReq.signal) }],
		}),
	);

	server.registerTool(
		"web_fetch",
		{
			title: "Web Fetch",
			description: `Read web pages as clean markdown, with JavaScript rendered. Up to 10 URLs per call. Each URL returns at most ${FETCH_WINDOW} characters; a truncated page's header gives the offset to continue from. Markdown conversion can alter structured data (e.g. it escapes _ in JSON keys), so fetch JSON or raw files with a plain HTTP client instead.`,
			inputSchema: z.object({
				urls: z.array(z.string().min(1)).min(1).max(10).describe("URLs to read (1–10)."),
				offset: z
					.number()
					.int()
					.min(0)
					.optional()
					.describe(
						"Character position to start from, applied to every URL. Default 0. To continue a truncated page, use the offset from its header note.",
					),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ urls, offset }, ctx) => ({
			content: [{ type: "text", text: await fetchPages(urls, offset ?? 0, ctx.mcpReq.signal) }],
		}),
	);

	return server;
}
