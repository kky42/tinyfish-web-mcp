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

export interface SearchParams {
	query: string;
	purpose?: string;
	domain_type?: DomainType;
	recency_minutes?: number;
	include_domains?: string;
	exclude_domains?: string;
}

interface SearchResult {
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
	return `HTTP ${res.status}${body ? `: ${body}` : ""}`;
}

export async function search(params: SearchParams, signal?: AbortSignal): Promise<string> {
	const key = requireApiKey();
	const sp = new URLSearchParams();
	for (const [name, value] of Object.entries(params)) {
		if (value !== undefined && value !== "") sp.set(name, String(value));
	}

	const res = await fetch(`${SEARCH_BASE}?${sp}`, { headers: { "X-API-Key": key }, signal });
	if (!res.ok) throw new Error(`TinyFish search failed: ${await errorFromResponse(res)}`);

	const data = (await res.json()) as { results?: SearchResult[]; total_results?: number };
	const results = data.results ?? [];
	const lines = [`[web_search] "${params.query}" — ${data.total_results ?? results.length} results`];
	if (results.length === 0) lines.push("(no results)");
	results.forEach((r, i) => lines.push(...formatSearchResult(r, params.domain_type, i + 1)));
	return lines.join("\n");
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

export async function fetchPages(urls: string[], offset: number, signal?: AbortSignal): Promise<string> {
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
	}
	for (const e of data.errors ?? []) lines.push(`✗ ${e.url} — ${e.error}`);
	if (lines.length === 0) lines.push("(no content returned)");
	return lines.join("\n");
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
