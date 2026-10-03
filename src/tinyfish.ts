/**
 * TinyFish REST client and result formatting, independent of MCP.
 *
 * web_fetch always requests markdown, one request per call. TinyFish's
 * markdown serializer escapes markdown-special characters in structured
 * payloads (e.g. JSON key `node_id` → `node\_id`); rather than re-fetching in
 * another format, the tool description sends callers to a plain HTTP client
 * when they need exact bytes.
 */

const SEARCH_BASE = "https://api.search.tinyfish.ai";
const FETCH_BASE = "https://api.fetch.tinyfish.ai";

/** Characters returned per URL per call; `offset` pages through the rest. */
export const FETCH_WINDOW = 20_000;

export type DomainType = "web" | "news" | "research_paper";

export const RECENCY_MINUTES = { hour: 60, day: 1440, week: 10_080, month: 43_200, year: 525_600 } as const;
export type Recency = keyof typeof RECENCY_MINUTES;

export interface SearchParams {
	query: string;
	domain_type?: DomainType;
	recency?: Recency;
	include_domains?: string[];
	exclude_domains?: string[];
}

export interface SearchResult {
	site_name?: string;
	title?: string;
	snippet?: string;
	url?: string;
	date?: string;
	publisher?: string;
	authors?: string[];
	venue?: string;
	year?: number;
	cited_by_count?: number;
	pdf_url?: string;
}

interface FetchResult {
	url: string;
	final_url?: string;
	title?: string;
	description?: string | null;
	text?: string | null;
}

interface FetchResponse {
	results?: FetchResult[];
	errors?: { url: string; error: string }[];
}

function requireApiKey(): string {
	const key = process.env.TINYFISH_API_KEY;
	if (!key) {
		throw new Error("TINYFISH_API_KEY is not set. Pass it in the MCP server's environment.");
	}
	return key;
}

async function errorFromResponse(res: Response): Promise<string> {
	let body = "";
	try {
		body = (await res.text()).slice(0, 500);
	} catch {
		/* ignore */
	}
	// TinyFish errors are {"error": {"code", "message"}}; keep just the message.
	try {
		const message = (JSON.parse(body) as { error?: { message?: string } }).error?.message;
		if (message) body = message;
	} catch {
		/* not JSON: keep the raw body */
	}
	return `HTTP ${res.status}${body ? `: ${body}` : ""}`;
}

export interface SearchOutput {
	text: string;
	data: {
		query: string;
		total_results: number;
		results: SearchResult[];
	};
}

export async function search(params: SearchParams, signal?: AbortSignal): Promise<SearchOutput> {
	const key = requireApiKey();
	// TinyFish takes domain lists as comma-separated strings and recency in minutes.
	const sp = new URLSearchParams({ query: params.query });
	if (params.domain_type) sp.set("domain_type", params.domain_type);
	if (params.recency) sp.set("recency_minutes", String(RECENCY_MINUTES[params.recency]));
	if (params.include_domains?.length) sp.set("include_domains", params.include_domains.join(","));
	if (params.exclude_domains?.length) sp.set("exclude_domains", params.exclude_domains.join(","));

	const res = await fetch(`${SEARCH_BASE}?${sp}`, { headers: { "X-API-Key": key }, signal });
	if (!res.ok) throw new Error(`TinyFish search failed: ${await errorFromResponse(res)}`);

	const data = (await res.json()) as { results?: SearchResult[]; total_results?: number };
	const results = data.results ?? [];
	const lines = [`[web_search] "${params.query}" — ${data.total_results ?? results.length} results`];
	if (results.length === 0) lines.push("(no results)");
	results.forEach((r, i) => lines.push(...formatSearchResult(r, params.domain_type, i + 1)));
	return {
		text: lines.join("\n"),
		data: { query: params.query, total_results: data.total_results ?? results.length, results },
	};
}

function formatSearchResult(r: SearchResult, domainType: DomainType | undefined, index: number): string[] {
	const lines = [`${index}. ${r.title ?? r.url ?? "(untitled)"}`];
	if (r.site_name) lines.push(`   site: ${r.site_name}`);
	if (r.url) lines.push(`   ${r.url}`);
	if (domainType === "news") {
		if (r.publisher) lines.push(`   publisher: ${r.publisher}`);
		if (r.date) lines.push(`   date: ${r.date}`);
	}
	if (domainType === "research_paper") {
		if (r.authors?.length) lines.push(`   authors: ${r.authors.join(", ")}`);
		if (r.venue) lines.push(`   venue: ${r.venue}`);
		if (r.year !== undefined) lines.push(`   year: ${r.year}`);
		if (r.cited_by_count !== undefined) lines.push(`   cited_by: ${r.cited_by_count}`);
		if (r.pdf_url) lines.push(`   pdf: ${r.pdf_url}`);
	}
	if (r.snippet) lines.push(`   ${r.snippet}`);
	return lines;
}

export interface FetchedPage {
	url: string;
	final_url?: string;
	title?: string;
	description?: string;
	/** The returned window of the page, as markdown. */
	text: string;
	/** Character range of `text` within the full page. */
	start: number;
	end: number;
	total_chars: number;
	/** Offset for the next web_fetch call, or null when the page is complete. */
	next_offset: number | null;
}

export interface FetchOutput {
	text: string;
	data: { pages: FetchedPage[]; errors: { url: string; error: string }[] };
}

export async function fetchPages(urls: string[], offset: number, signal?: AbortSignal): Promise<FetchOutput> {
	const key = requireApiKey();
	const res = await fetch(FETCH_BASE, {
		method: "POST",
		headers: { "X-API-Key": key, "Content-Type": "application/json" },
		body: JSON.stringify({ urls, format: "markdown" }),
		signal,
	});
	if (!res.ok) throw new Error(`TinyFish fetch failed: ${await errorFromResponse(res)}`);

	const data = (await res.json()) as FetchResponse;
	const lines: string[] = [];
	const pages: FetchedPage[] = [];
	for (const r of data.results ?? []) {
		// Lead with the requested URL so multi-URL results map back to their
		// inputs; surface redirects since relative links resolve against final_url.
		const { text, note } = sliceWindow(r.url, r.text ?? "", offset, FETCH_WINDOW);
		lines.push(`— ${r.url}`);
		if (r.final_url && r.final_url !== r.url) lines.push(`  redirected to: ${r.final_url}`);
		if (r.title) lines.push(`  title: ${r.title}`);
		if (r.description) lines.push(`  ${r.description}`);
		// The position note goes before the text, not after: clients cap MCP
		// output (pi-mcp-adapter at 50 KiB, Claude Code at ~25k tokens) by cutting
		// the tail, which would drop a trailing note for later URLs.
		if (note) lines.push(`  ${note}`);
		lines.push(text, "");

		const total = (r.text ?? "").length;
		const end = Math.min(offset + text.length, total);
		pages.push({
			url: r.url,
			...(r.final_url && r.final_url !== r.url && { final_url: r.final_url }),
			...(r.title && { title: r.title }),
			...(r.description && { description: r.description }),
			text,
			start: Math.min(offset, total),
			end,
			total_chars: total,
			next_offset: end < total ? end : null,
		});
	}
	const errors = data.errors ?? [];
	for (const e of errors) lines.push(`✗ ${e.url} — ${e.error}`);
	if (lines.length === 0) lines.push("(no content returned)");
	return { text: lines.join("\n"), data: { pages, errors } };
}

/**
 * Return text[offset, offset + size) plus a position note whenever the page
 * continues past the window or the window doesn't start at 0. The note spells
 * out the exact follow-up call so callers page forward instead of re-reading.
 * TinyFish has no range support, so every window re-fetches the whole
 * document; offsets can drift slightly if the page changes between calls.
 */
export function sliceWindow(
	url: string,
	page: string,
	offset: number,
	size: number,
): { text: string; note?: string } {
	const total = page.length;
	if (offset > 0 && offset >= total) {
		return { text: "", note: `[offset ${offset} is past the end of the page (${total} chars)]` };
	}

	const end = Math.min(offset + size, total);
	const text = page.slice(offset, end);
	if (end < total) {
		return {
			text,
			note: `[showing chars ${offset}–${end} of ${total}; to continue, call web_fetch with urls ["${url}"] and offset ${end}]`,
		};
	}
	if (offset > 0) return { text, note: `[showing chars ${offset}–${end} of ${total}; end of page]` };
	return { text };
}
