#!/usr/bin/env node
// A stand-in for the PDF Conversion API, for SDK tests. Zero dependencies; Node.js 18 or later.
//
//   node mock-server.mjs [--port 0]
//
// Prints one line when ready, `LISTENING http://127.0.0.1:<port>`, then serves until killed.
// The valid API key is `test-key`. See README.md for the scenarios and cases.json for the
// shared test cases every SDK runs against this server.
//
// "Conversions" here are identity copies: an output file holds exactly the bytes that were
// uploaded (merge-style tools concatenate their inputs), so a test can check the round trip.
// Multipart bodies are parsed the way the real API parses them: the file name is read from a
// raw UTF-8 `filename="..."` only; `filename*` is ignored, like the API ignores it.

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";

const KEY = "test-key";
const MAX_BODY = 110 * 1024 * 1024;

const portIndex = process.argv.indexOf("--port");
const PORT = portIndex >= 0 ? Number(process.argv[portIndex + 1]) : 0;

const attempts = new Map(); // MockId -> requests seen with that id
const stored = new Map(); // FileId -> { name, ext, data }
let requestSeq = 0;

const USAGE = {
	Plan: "Free",
	Included: 250,
	Used: 12,
	Remaining: 238,
	Overage: false,
	Running: 0,
	ConcurrentLimit: 1,
	MaxUploadMB: 10,
	PeriodStart: "2026-11-01T00:00:00.000Z",
	PeriodEnd: "2026-12-01T00:00:00.000Z",
};

const INFO = [
	{ From: "docx", To: "pdf", Title: "DOCX to PDF", Category: "Document", Inputs: "one" },
	{ From: "pdf", To: "jpg", Title: "PDF to JPG", Category: "PDF", Inputs: "one" },
	{ From: "pdf", To: "merge", Title: "PDF to MERGE", Category: "PDF Tools", Inputs: "many" },
	{ From: "images", To: "pdf", Title: "IMAGES to PDF", Category: "Image", Inputs: "many" },
	{ From: "data", To: "barcode", Title: "DATA to BARCODE", Category: "Barcode", Inputs: "optional" },
];

// Error scenarios: status, message, Retry-After, and how the body is written.
const ERRORS = {
	"400": { status: 400, message: "PageRange '3-1' is not valid (example: 1-3,5)" },
	"403": { status: 403, message: "this key's plan is not set up; write to support" },
	"404": { status: 404, message: "conversion from docx to dwg is not supported" },
	"413": { status: 413, message: "the Free plan accepts uploads up to 10 MB, all files together" },
	"413-html": { status: 413, html: true },
	"422": { status: 422, message: "the input file is password-protected" },
	"429-rate": { status: 429, message: "too many requests; slow down", retryAfter: 1 },
	"429-concurrency": { status: 429, message: "the Free plan runs 1 conversion at a time; wait for the one running to finish", retryAfter: 1 },
	"429-quota": { status: 429, message: "this month's 250 conversions on the Free plan are used up; the count starts again on 2026-12-01 (UTC)", retryAfter: 2_000_000 },
	"500": { status: 500, message: "internal error" },
	"503-busy": { status: 503, message: "the server is busy; retry shortly", retryAfter: 1 },
	"503-paused": { status: 503, message: "conversions on the Free plan are paused for a while; try again later", retryAfter: 600 },
	"504-empty": { status: 504, empty: true },
	"400-text": { status: 400, text: "Invalid `boundary` for `multipart/form-data` request" },
	"bad-json": { status: 200, raw: "{not json" },
	drop: { drop: true },
	truncated: { truncated: true },
};

const CONTENT_TYPES = {
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	txt: "text/plain; charset=utf-8",
	json: "application/json",
	zip: "application/zip",
};

function requestId() {
	requestSeq += 1;
	return `mock-${String(requestSeq).padStart(6, "0")}`;
}

function sendJson(res, status, body, headers = {}) {
	const text = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(text),
		"X-Content-Type-Options": "nosniff",
		"x-request-id": requestId(),
		...headers,
	});
	res.end(text);
}

function sendError(res, status, message, headers = {}) {
	sendJson(res, status, { Code: status, Message: message }, headers);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY) {
				reject(new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}

/** Parses a multipart/form-data body. Returns [{ name, filename|null, data: Buffer, contentType|null }]
 * in body order, or null when the body isn't a multipart form with a usable boundary. */
function parseMultipart(contentType, body) {
	const match = /^multipart\/form-data\s*;.*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
	if (!match) return null;
	const boundary = Buffer.from(`--${match[1] ?? match[2]}`);
	const parts = [];
	let pos = body.indexOf(boundary);
	if (pos < 0) return null;
	while (true) {
		pos += boundary.length;
		if (body.slice(pos, pos + 2).toString() === "--") break; // closing boundary
		if (body.slice(pos, pos + 2).toString() === "\r\n") pos += 2;
		const headerEnd = body.indexOf("\r\n\r\n", pos);
		if (headerEnd < 0) return null;
		const headerText = body.slice(pos, headerEnd).toString("utf8");
		const next = body.indexOf(Buffer.concat([Buffer.from("\r\n"), boundary]), headerEnd + 4);
		if (next < 0) return null;
		const data = body.slice(headerEnd + 4, next);
		const headers = {};
		for (const line of headerText.split("\r\n")) {
			const i = line.indexOf(":");
			if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
		}
		const disposition = headers["content-disposition"] ?? "";
		const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1];
		// A part with any filename parameter is a file. Its name comes from a plain filename="..."
		// only, as in the real API: a part with just filename*= is a file without a name.
		const isFile = /;\s*filename\*?=/i.test(disposition);
		const filename = isFile ? (/(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1] ?? "") : null;
		if (name !== undefined) parts.push({ name, filename, data, contentType: headers["content-type"] ?? null });
		pos = next + 2;
	}
	return parts;
}

const truthy = (v) => /^(true|1|yes|on)$/i.test(String(v ?? "").trim());
const FORMAT = /^[A-Za-z0-9-]{1,20}$/;
const MAIN_FILE = /^files?(\[\d+\])?$/i;
const MULTI_TOOLS = { merge: "pdf", join: "png", zip: "zip" };

/** The output's base name: FileName without its extension, else the upload's name without
 * folders or extension, else "file". */
function baseName(fileNameParam, uploadName) {
	const clean = (s) => s.replace(/[^\p{L}\p{N}\-_. ]/gu, "_").replace(/^[. ]+|[. ]+$/g, "");
	if (fileNameParam) {
		const withoutExt = fileNameParam.includes(".") ? fileNameParam.slice(0, fileNameParam.lastIndexOf(".")) : fileNameParam;
		const cleaned = clean(withoutExt);
		if (cleaned) return cleaned;
	}
	if (uploadName) {
		const last = uploadName.split(/[\\/]/).pop();
		const withoutExt = last.includes(".") ? last.slice(0, last.lastIndexOf(".")) : last;
		const cleaned = clean(withoutExt);
		if (cleaned) return cleaned;
	}
	return "file";
}

function outputEntry(name, ext, data, store, origin) {
	if (store) {
		const id = randomBytes(16).toString("hex");
		stored.set(id, { name, ext, data });
		return { FileName: name, FileExt: ext, FileSize: data.length, Url: `${origin}/v2/d/${id}/${encodeURIComponent(name)}`, FileId: id };
	}
	return { FileName: name, FileExt: ext, FileSize: data.length, FileData: data.toString("base64") };
}

async function convert(req, res, from, to, origin, url) {
	if (!FORMAT.test(from) || !FORMAT.test(to)) return sendError(res, 400, "invalid format in the URL");
	const body = await readBody(req);
	const parts = parseMultipart(req.headers["content-type"], body);
	if (!parts) {
		res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "x-request-id": requestId() });
		return res.end("Invalid `boundary` for `multipart/form-data` request");
	}

	const params = {}; // lower-case name -> value (last wins)
	const mainFiles = [];
	const fields = [];
	for (const p of parts) {
		if (p.filename !== null) {
			fields.push({ name: p.name, filename: p.filename, size: p.data.length, sha256: createHash("sha256").update(p.data).digest("hex"), contentType: p.contentType });
			if (MAIN_FILE.test(p.name)) mainFiles.push(p);
		} else {
			const value = p.data.toString("utf8");
			fields.push({ name: p.name, value });
			if (value !== "") params[p.name.toLowerCase()] = value;
		}
	}

	// Every request that carries a MockId is counted, a refused one included.
	const scenario = (params.mockscenario ?? "convert").toLowerCase();
	const id = params.mockid ?? "";
	let attempt = 1;
	if (id) {
		attempt = (attempts.get(id) ?? 0) + 1;
		attempts.set(id, attempt);
	}

	if (req.headers.authorization !== `Bearer ${KEY}`) {
		return sendError(res, 401, "a valid API key is required (Authorization: Bearer <key>)", { "www-authenticate": "Bearer" });
	}
	if (params.mockdelayms) await new Promise((r) => setTimeout(r, Number(params.mockdelayms)));

	// An error scenario fails every time, or only its first MockFailures attempts.
	const failures = params.mockfailures === undefined ? Infinity : Number(params.mockfailures);
	const error = ERRORS[scenario];
	if (error && attempt <= failures) {
		if (error.drop) {
			req.socket.destroy();
			return;
		}
		if (error.truncated) {
			// A 200 whose body stops early: the status line arrived, then the connection drops.
			res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000", "x-request-id": requestId() });
			res.write('{"ConversionCost":1,"Files":[');
			setTimeout(() => req.socket.destroy(), 50);
			return;
		}
		const headers = error.retryAfter !== undefined ? { "Retry-After": String(error.retryAfter) } : {};
		if (error.html) {
			res.writeHead(error.status, { "Content-Type": "text/html" }); // the edge network's page: no x-request-id
			return res.end("<html><body><h1>413 Request Entity Too Large</h1></body></html>");
		}
		if (error.empty) {
			res.writeHead(error.status, { "Content-Type": "application/json", "x-request-id": requestId() });
			return res.end();
		}
		if (error.text) {
			res.writeHead(error.status, { "Content-Type": "text/plain; charset=utf-8", "x-request-id": requestId() });
			return res.end(error.text);
		}
		if (error.raw) {
			res.writeHead(error.status, { "Content-Type": "application/json", "x-request-id": requestId() });
			return res.end(error.raw);
		}
		return sendError(res, error.status, error.message, headers);
	}

	const store = truthy(params.storefile);
	const toLower = to.toLowerCase();
	const fromLower = from.toLowerCase();

	if (scenario === "echo") {
		const echo = {
			method: req.method,
			path: url.pathname,
			query: url.search.replace(/^\?/, ""),
			headers: {
				authorization: req.headers.authorization ?? null,
				"user-agent": req.headers["user-agent"] ?? null,
				"content-type": req.headers["content-type"] ?? null,
				accept: req.headers.accept ?? null,
			},
			fields,
		};
		const data = Buffer.from(JSON.stringify(echo, null, 2));
		return sendJson(res, 200, { ConversionCost: 1, ConversionTime: 0.001, Files: [outputEntry("request.json", "json", data, store, origin)] });
	}

	if (mainFiles.length === 0) {
		// data/to/qrcode and data/to/barcode take no file: the output is made from Data and named
		// after the tool, like the real API does (qrcode.svg). Everything else needs a file.
		if (fromLower !== "data") return sendError(res, 400, "no input file was provided");
		const name = `${baseName(params.filename, null) === "file" ? toLower : baseName(params.filename, null)}.svg`;
		return sendJson(res, 200, { ConversionCost: 1, ConversionTime: 0.004, Files: [outputEntry(name, "svg", Buffer.from(params.data ?? ""), store, origin)] });
	}
	const multiTool = MULTI_TOOLS[toLower] !== undefined || (fromLower === "images" && toLower === "pdf");
	if (!multiTool && mainFiles.length > 1) return sendError(res, 400, "this conversion takes exactly one file");

	const ext = MULTI_TOOLS[toLower] ?? toLower;
	const base = baseName(params.filename, mainFiles[0].filename);
	let files;
	if (scenario === "multi") {
		files = [1, 2, 3].map((n) => outputEntry(`${base}-${n}.${ext}`, ext, Buffer.from(`page ${n}\n`), store, origin));
	} else if (multiTool) {
		files = [outputEntry(`${base}.${ext}`, ext, Buffer.concat(mainFiles.map((f) => f.data)), store, origin)];
	} else {
		files = [outputEntry(`${base}.${ext}`, ext, mainFiles[0].data, store, origin)];
	}
	if (scenario === "size-mismatch" && files[0].FileSize !== undefined) files[0].FileSize += 1;
	return sendJson(res, 200, { ConversionCost: 1, ConversionTime: 0.012, Files: files });
}

const server = createServer(async (req, res) => {
	const origin = `http://${req.headers.host}`;
	const url = new URL(req.url, origin);
	const path = url.pathname;
	const authorized = req.headers.authorization === `Bearer ${KEY}`;
	const unauthorized = () => sendError(res, 401, "a valid API key is required (Authorization: Bearer <key>)", { "www-authenticate": "Bearer" });
	try {
		let m;
		if (req.method === "POST" && (m = /^\/v2\/convert\/([^/]+)\/to\/([^/]+)$/.exec(path))) {
			return await convert(req, res, decodeURIComponent(m[1]), decodeURIComponent(m[2]), origin, url);
		}
		if (req.method === "GET" && path === "/v2/usage") return authorized ? sendJson(res, 200, USAGE) : unauthorized();
		if (req.method === "GET" && path === "/v2/info") return sendJson(res, 200, INFO);
		if (req.method === "GET" && path === "/health") return sendJson(res, 200, { status: "ok" });
		if (req.method === "GET" && (m = /^\/v2\/d\/([0-9a-f]{32})\/([^/]+)$/.exec(path))) {
			const file = stored.get(m[1]);
			if (!file) return sendError(res, 404, "not found");
			res.writeHead(200, {
				"Content-Type": CONTENT_TYPES[file.ext] ?? "application/octet-stream",
				"Content-Length": file.data.length,
				"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
				"Cache-Control": "private, no-store",
				"x-request-id": requestId(),
			});
			return res.end(file.data);
		}
		if (req.method === "DELETE" && (m = /^\/v2\/d\/([^/]+)$/.exec(path))) {
			if (!authorized) return unauthorized();
			if (!stored.delete(m[1])) return sendError(res, 404, "not found");
			res.writeHead(204, { "x-request-id": requestId() });
			return res.end();
		}
		// Test helpers, not part of the API.
		if (req.method === "GET" && (m = /^\/__mock\/attempts\/(.+)$/.exec(path))) {
			return sendJson(res, 200, { attempts: attempts.get(decodeURIComponent(m[1])) ?? 0 });
		}
		return sendError(res, 404, "not found");
	} catch (e) {
		if (!res.headersSent) sendError(res, 500, `mock error: ${e.message}`);
	}
});

server.keepAliveTimeout = 5_000;
server.listen(PORT, "127.0.0.1", () => {
	console.log(`LISTENING http://127.0.0.1:${server.address().port}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
