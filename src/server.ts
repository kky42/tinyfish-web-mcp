import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { FETCH_WINDOW, RECENCY_MINUTES, type Recency, fetchPages, search } from "./tinyfish.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const searchResultSchema = z.object({
	position: z.number().optional(),
	title: z.string().optional(),
	url: z.string().optional(),
	site_name: z.string().optional(),
	snippet: z.string().optional(),
	date: z.string().optional(),
	publisher: z.string().optional(),
	authors: z.array(z.string()).optional(),
	venue: z.string().optional(),
	year: z.number().optional(),
	cited_by_count: z.number().optional(),
	pdf_url: z.string().optional(),
});

const fetchPageSchema = z.object({
	url: z.string(),
	final_url: z.string().optional(),
	title: z.string().optional(),
	description: z.string().optional(),
	text: z.string().describe("Markdown of chars [start, end) of the page."),
	start: z.number(),
	end: z.number(),
	total_chars: z.number(),
	next_offset: z.number().nullable().describe("Offset for the next call, or null when the page is complete."),
});

export function createServer(): McpServer {
	const server = new McpServer(
		{ name: "tinyfish-web", version },
		{
			// Shown by clients that run tools from scripts (e.g. pi codemode), where the
			// model sees raw results instead of formatted text.
			instructions:
				"Search the web with web_search, then read pages with web_fetch (argument `urls` is an array). " +
				"Results carry structuredContent: web_search {results[{title,url,snippet}]}, web_fetch {pages[{url,text,next_offset}],errors}. " +
				"Check isError before reading structuredContent.",
		},
	);

	server.registerTool(
		"web_search",
		{
			title: "Web Search",
			description:
				"Search the live web. Returns up to 10 ranked results (title, URL, snippet; plus date and publisher for news, authors/venue/citations for papers). Use it to find URLs, then read them with web_fetch. In scripts, read structuredContent.results[{title,url,snippet,...}]; check isError first.",
			inputSchema: z.object({
				query: z.string().min(1).describe("Search keywords."),
				domain_type: z
					.enum(["web", "news", "research_paper"])
					.optional()
					.describe("Result type (default web)."),
				recency: z
					.enum(Object.keys(RECENCY_MINUTES) as [Recency, ...Recency[]])
					.optional()
					.describe("Only results from the last hour, day, week, month or year. Not supported with domain_type research_paper."),
				include_domains: z
					.array(z.string())
					.optional()
					.describe('Limit results to these domains, e.g. ["github.com", "arxiv.org"].'),
				exclude_domains: z
					.array(z.string())
					.optional()
					.describe('Exclude these domains, e.g. ["pinterest.com"]. Returns no results with domain_type news.'),
			}),
			outputSchema: z.object({
				query: z.string(),
				total_results: z.number(),
				results: z.array(searchResultSchema),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async (params, ctx) => {
			const { text, data } = await search(params, ctx.mcpReq.signal);
			return { content: [{ type: "text", text }], structuredContent: data };
		},
	);

	server.registerTool(
		"web_fetch",
		{
			title: "Web Fetch",
			description: `Read web pages as clean markdown, with JavaScript rendered. Up to 10 URLs per call. Each URL returns at most ${FETCH_WINDOW} characters; a truncated page's header gives the offset to continue from. In scripts, read structuredContent.pages[{url,title,text,next_offset}] and .errors; next_offset is null when the page is complete. Markdown conversion can alter structured data (e.g. it escapes _ in JSON keys), so fetch JSON or raw files with a plain HTTP client instead.`,
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
			outputSchema: z.object({
				pages: z.array(fetchPageSchema),
				errors: z.array(z.object({ url: z.string(), error: z.string() })),
			}),
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		async ({ urls, offset }, ctx) => {
			const { text, data } = await fetchPages(urls, offset ?? 0, ctx.mcpReq.signal);
			// A per-URL failure in a mixed batch stays a normal result; only a call
			// that returned nothing usable is an error, so codemode scripts reject.
			const failed = data.pages.length === 0 && data.errors.length > 0;
			return { content: [{ type: "text", text }], structuredContent: data, ...(failed && { isError: true }) };
		},
	);

	return server;
}
