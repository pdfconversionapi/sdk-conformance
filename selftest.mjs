#!/usr/bin/env node
// Checks mock-server.mjs at the HTTP level, without any SDK: node selftest.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";

const here = new URL(".", import.meta.url);
const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, here));
const server = spawn(process.execPath, [new URL("mock-server.mjs", here).pathname, "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
const base = await new Promise((resolve) => {
	createInterface({ input: server.stdout }).once("line", (line) => resolve(line.replace(/^LISTENING /, "")));
});
const auth = { Authorization: "Bearer test-key" };
let passed = 0;

async function check(name, fn) {
	try {
		await fn();
		passed++;
	} catch (e) {
		console.error(`FAIL ${name}: ${e.message}`);
		process.exitCode = 1;
	}
}

function form(params = {}, files = [["File", "hello.txt"]]) {
	const fd = new FormData();
	for (const [field, name] of files) fd.append(field, new Blob([fixture(name)]), name);
	for (const [k, v] of Object.entries(params)) fd.append(k, String(v));
	return fd;
}
const post = (path, body, headers = auth) => fetch(`${base}${path}`, { method: "POST", headers, body });
const attempts = async (id) => (await (await fetch(`${base}/__mock/attempts/${id}`)).json()).attempts;

await check("convert identity", async () => {
	const r = await post("/v2/convert/txt/to/pdf", form());
	assert.equal(r.status, 200);
	assert.match(r.headers.get("x-request-id"), /^mock-\d+$/);
	const j = await r.json();
	assert.equal(j.Files[0].FileName, "hello.pdf");
	assert.equal(Buffer.from(j.Files[0].FileData, "base64").toString(), fixture("hello.txt").toString());
	assert.equal(j.Files[0].FileSize, 38);
});
await check("wrong key counts attempt", async () => {
	const r = await post("/v2/convert/txt/to/pdf", form({ MockId: "wk" }), { Authorization: "Bearer nope" });
	assert.equal(r.status, 401);
	assert.equal(r.headers.get("www-authenticate"), "Bearer");
	assert.equal(await attempts("wk"), 1);
});
await check("echo", async () => {
	const r = await post("/v2/convert/txt/to/pdf", form({ MockScenario: "echo", PageRange: "1-3" }));
	const j = await r.json();
	const echo = JSON.parse(Buffer.from(j.Files[0].FileData, "base64").toString());
	assert.equal(echo.path, "/v2/convert/txt/to/pdf");
	assert.equal(echo.headers.authorization, "Bearer test-key");
	assert.deepEqual(echo.fields[0].name, "File");
	assert.equal(echo.fields[0].filename, "hello.txt");
	assert.ok(echo.fields.some((f) => f.name === "PageRange" && f.value === "1-3"));
});
await check("filename* is ignored, raw UTF-8 is read", async () => {
	for (const [disposition, expected] of [
		[`filename="Résumé final (1).txt"`, "Résumé final _1_.pdf"],
		[`filename*=UTF-8''R%C3%A9sum%C3%A9.txt`, "file.pdf"],
	]) {
		const b = "xyzBOUNDARY";
		const body = Buffer.concat([
			Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="File"; ${disposition}\r\n\r\n`),
			fixture("hello.txt"),
			Buffer.from(`\r\n--${b}--\r\n`),
		]);
		const r = await post("/v2/convert/txt/to/pdf", body, { ...auth, "Content-Type": `multipart/form-data; boundary=${b}` });
		assert.equal((await r.json()).Files[0].FileName, expected);
	}
});
await check("non-multipart body", async () => {
	const r = await post("/v2/convert/txt/to/pdf", JSON.stringify({ a: 1 }), { ...auth, "Content-Type": "application/json" });
	assert.equal(r.status, 400);
	assert.match(r.headers.get("content-type"), /^text\/plain/);
});
await check("merge concatenates", async () => {
	const r = await post("/v2/convert/pdf/to/merge", form({}, [["Files", "a.txt"], ["Files", "b.txt"], ["Files", "c.txt"]]));
	const j = await r.json();
	assert.equal(j.Files.length, 1);
	assert.equal(j.Files[0].FileName, "a.pdf");
	assert.equal(Buffer.from(j.Files[0].FileData, "base64").toString(), "A\nB\nC\n");
});
await check("two files on one-file conversion", async () => {
	const r = await post("/v2/convert/txt/to/pdf", form({}, [["Files", "a.txt"], ["Files", "b.txt"]]));
	assert.equal(r.status, 400);
});
await check("multi", async () => {
	const j = await (await post("/v2/convert/txt/to/pdf", form({ MockScenario: "multi", FileName: "x.doc" }))).json();
	assert.deepEqual(j.Files.map((f) => f.FileName), ["x-1.pdf", "x-2.pdf", "x-3.pdf"]);
});
await check("error scenarios", async () => {
	const expectations = {
		"400": [400, "application/json", null],
		"403": [403, "application/json", null],
		"404": [404, "application/json", null],
		"413": [413, "application/json", null],
		"413-html": [413, "text/html", null],
		"422": [422, "application/json", null],
		"429-rate": [429, "application/json", "1"],
		"429-concurrency": [429, "application/json", "1"],
		"429-quota": [429, "application/json", "2000000"],
		"500": [500, "application/json", null],
		"503-busy": [503, "application/json", "1"],
		"503-paused": [503, "application/json", "600"],
		"504-empty": [504, "application/json", null],
		"400-text": [400, "text/plain", null],
		"bad-json": [200, "application/json", null],
	};
	for (const [scenario, [status, type, retryAfter]] of Object.entries(expectations)) {
		const r = await post("/v2/convert/txt/to/pdf", form({ MockScenario: scenario }));
		assert.equal(r.status, status, scenario);
		assert.ok(r.headers.get("content-type").startsWith(type), `${scenario} content-type`);
		assert.equal(r.headers.get("retry-after"), retryAfter, `${scenario} retry-after`);
		assert.equal(r.headers.has("x-request-id"), scenario !== "413-html", `${scenario} x-request-id`);
		const text = await r.text();
		if (scenario === "504-empty") assert.equal(text, "");
	}
});
await check("failures then success", async () => {
	for (let i = 1; i <= 3; i++) {
		const r = await post("/v2/convert/txt/to/pdf", form({ MockScenario: "503-busy", MockFailures: 2, MockId: "ft" }));
		assert.equal(r.status, i <= 2 ? 503 : 200);
	}
	assert.equal(await attempts("ft"), 3);
});
await check("drop closes the connection", async () => {
	await assert.rejects(post("/v2/convert/txt/to/pdf", form({ MockScenario: "drop", MockFailures: 1, MockId: "dr" })));
	const r = await post("/v2/convert/txt/to/pdf", form({ MockScenario: "drop", MockFailures: 1, MockId: "dr" }));
	assert.equal(r.status, 200);
	assert.equal(await attempts("dr"), 2);
});
await check("no files: data/to/qrcode works, others get 400", async () => {
	const fd = new FormData();
	fd.append("Data", "hello-sdk");
	const j = await (await post("/v2/convert/data/to/qrcode", fd)).json();
	assert.equal(j.Files[0].FileName, "qrcode.svg");
	assert.equal(Buffer.from(j.Files[0].FileData, "base64").toString(), "hello-sdk");
	const fd2 = new FormData();
	fd2.append("PageRange", "1");
	const r = await post("/v2/convert/txt/to/pdf", fd2);
	assert.equal(r.status, 400);
	assert.equal((await r.json()).Message, "no input file was provided");
});
await check("truncated 200", async () => {
	const r = await post("/v2/convert/txt/to/pdf", form({ MockScenario: "truncated" }));
	assert.equal(r.status, 200);
	await assert.rejects(r.text());
});
await check("size mismatch", async () => {
	const j = await (await post("/v2/convert/txt/to/pdf", form({ MockScenario: "size-mismatch" }))).json();
	assert.equal(j.Files[0].FileSize, 39);
});
await check("stored file flow", async () => {
	const j = await (await post("/v2/convert/txt/to/pdf", form({ StoreFile: "true" }))).json();
	const f = j.Files[0];
	assert.equal(f.FileData, undefined);
	assert.match(f.FileId, /^[0-9a-f]{32}$/);
	assert.equal(f.Url, `${base}/v2/d/${f.FileId}/hello.pdf`);
	const d = await fetch(f.Url);
	assert.equal(d.status, 200);
	assert.equal(d.headers.get("content-type"), "application/pdf");
	assert.equal(Buffer.from(await d.arrayBuffer()).toString(), fixture("hello.txt").toString());
	assert.equal((await fetch(`${base}/v2/d/${f.FileId}`, { method: "DELETE" })).status, 401);
	assert.equal((await fetch(`${base}/v2/d/${f.FileId}`, { method: "DELETE", headers: auth })).status, 204);
	assert.equal((await fetch(`${base}/v2/d/${f.FileId}`, { method: "DELETE", headers: auth })).status, 404);
	assert.equal((await fetch(f.Url)).status, 404);
});
await check("usage and info", async () => {
	assert.equal((await fetch(`${base}/v2/usage`)).status, 401);
	const u = await (await fetch(`${base}/v2/usage`, { headers: auth })).json();
	assert.equal(u.Remaining, 238);
	const info = await (await fetch(`${base}/v2/info`)).json();
	assert.equal(info.length, 5);
});
await check("invalid format in path", async () => {
	const r = await post("/v2/convert/t%20xt/to/pdf", form());
	assert.equal(r.status, 400);
});
await check("slow", async () => {
	const t = Date.now();
	await post("/v2/convert/txt/to/pdf", form({ MockDelayMs: 300 }));
	assert.ok(Date.now() - t >= 300);
});
await check("cases.json parses and ids are unique", async () => {
	const cases = JSON.parse(readFileSync(new URL("cases.json", here))).cases;
	assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
});

server.kill();
console.log(`${passed} checks passed${process.exitCode ? ", some failed" : ""}`);
