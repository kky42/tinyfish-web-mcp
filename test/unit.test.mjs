import assert from "node:assert/strict";
import { test } from "node:test";
import { sliceWindow } from "../dist/tinyfish.js";

const URL = "https://example.com/doc";

// Follow position notes the way a model would, collecting every window.
function readAll(page, size) {
	const windows = [];
	let offset = 0;
	for (;;) {
		const { text, note } = sliceWindow(URL, page, offset, size);
		windows.push(text);
		const next = note?.match(/and offset (\d+)\]$/);
		if (!next) return { windows, lastNote: note };
		offset = Number(next[1]);
	}
}

test("a page that fits in one window has no position note", () => {
	assert.deepEqual(sliceWindow(URL, "short page", 0, 100), { text: "short page" });
});

test("following position notes reads the whole page exactly once", () => {
	const page = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
	const { windows, lastNote } = readAll(page, 1000);
	assert.equal(windows.join(""), page);
	assert.ok(windows.every((w) => w.length <= 1000));
	assert.match(lastNote, /end of page\]$/);
});

test("the continuation note names the URL to re-request", () => {
	const { note } = sliceWindow(URL, "x".repeat(50), 0, 20);
	assert.ok(note.includes(`urls ["${URL}"] and offset 20]`));
});

test("an offset past the end reports the page length instead of empty text", () => {
	assert.deepEqual(sliceWindow(URL, "abc", 10, 5), {
		text: "",
		note: "[offset 10 is past the end of the page (3 chars)]",
	});
});
