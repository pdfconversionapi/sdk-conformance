# Conformance suite

Shared test cases that every SDK runs, so all of them behave the same way.

| File | What it is |
|---|---|
| `mock-server.mjs` | A stand-in for the API (Node.js 18+, no dependencies). The valid key is `test-key`. |
| `cases.json` | The cases. Every SDK runs every one. |
| `fixtures/` | Input files the cases refer to (paths are relative to this folder). |
| `selftest.mjs` | Checks the mock itself over plain HTTP: `node selftest.mjs`. |
| `samples/` | Real documents for the SDKs' live tests against the real API (not used by the cases). |
| `.local-api.env` | Base URL and key of the real API running locally for live tests. Not in git; never print the key. |

Each SDK repository keeps a copy of this folder in `conformance/` (with a `SOURCE` file naming the
commit it was copied from), and its CI and release workflows fail when that copy is missing.

## Live tests

Every SDK also has live tests that call the real API with the files in `samples/`. They take the
API's address and key from `.local-api.env` (`PDFCONVERSIONAPI_LOCAL_BASE_URL` and
`PDFCONVERSIONAPI_LOCAL_KEY`) when that file exists. Without it, they use
`PDFCONVERSIONAPI_LIVE_BASE_URL` and `PDFCONVERSIONAPI_KEY` from the environment; the release
workflows set those for the production API from the `PDFCONVERSIONAPI_KEY` secret. With neither,
the live tests are skipped. A key in `PDFCONVERSIONAPI_KEY` alone never starts them, so running an
SDK's tests with your own key set doesn't use your conversions. `PDFCONVERSIONAPI_SAMPLES_DIR`
points them at another copy of `samples/`.

## Running the mock

```bash
node mock-server.mjs --port 0
```

The first line on stdout is `LISTENING http://127.0.0.1:<port>`. Start it once per test run on a
random port, read that line, run the cases, then kill the process.

Conversions are identity copies: an output holds exactly the bytes uploaded, so tests can check
the round trip. `merge`, `join` and `zip` tools (and `images/to/pdf`) concatenate their inputs
into one output named after the first input.

## Scenarios

Tests steer the mock with ordinary parameters, which the SDK sends like any other:

| Parameter | Effect |
|---|---|
| `MockScenario` | Which behaviour (below). Default `convert`. |
| `MockId` | Counts requests carrying this id. `GET /__mock/attempts/<MockId>` returns `{"attempts": n}`. |
| `MockFailures` | For an error scenario: fail only the first n attempts with this `MockId`, then convert normally. Without it the scenario fails every time. |
| `MockDelayMs` | Wait this long before answering (for client timeouts). |

| `MockScenario` | Response |
|---|---|
| `convert` | 200, identity conversion. Honors `FileName` and `StoreFile`. |
| `echo` | 200 with one output, `request.json`, describing the request received: `method`, `path`, `query`, `headers` (`authorization`, `user-agent`, `content-type`, `accept`) and `fields` in body order (`{name, filename, size, sha256, contentType}` for files, `{name, value}` for text). |
| `multi` | 200 with three outputs, `<base>-1.<ext>` to `-3`, holding `page 1\n` to `page 3\n`. |
| `size-mismatch` | 200 with `FileSize` one more than the data. |
| `bad-json` | 200 with a body that isn't JSON. |
| `400`, `403`, `404`, `413`, `422`, `500` | That status with a JSON error and the real API's message for it. |
| `413-html` | 413 HTML page with no `x-request-id`, like the edge network's. |
| `400-text` | 400 with the plain-text body the API sends for a non-multipart request. |
| `504-empty` | 504 with `Content-Type: application/json` and an empty body. |
| `429-rate`, `429-concurrency` | 429 with `Retry-After: 1`. |
| `429-quota` | 429 for a used-up month, `Retry-After: 2000000`. |
| `503-busy` | 503 with `Retry-After: 1`. |
| `503-paused` | 503 with `Retry-After: 600`. |
| `drop` | Closes the connection without a response. |
| `truncated` | Sends a 200 status line and part of the body, then closes the connection. |

With no input file, `data/to/<tool>` answers like the real API: one SVG named after the tool
(`qrcode.svg`, or `FileName` with `.svg`) holding the `Data` parameter's text. Any other
conversion without a file answers `400 no input file was provided`.

The mock also serves `GET /v2/usage` (key needed), `GET /v2/info` (5 entries, no key),
`GET /v2/d/{id}/{name}` (stored files) and `DELETE /v2/d/{id}` (key needed, 204 or 404). It reads
multipart file names like the real API: raw UTF-8 `filename="..."` only, `filename*` ignored.

## Case format

```json
{ "id": "...", "description": "...", "call": "convert", "client": {}, "from": "txt", "to": "pdf",
  "files": [], "params": {}, "options": {}, "expect": {} }
```

**`client`** (all optional): `api_key` (a string, or `null` for no key: build the client without
a key and make sure `PDFCONVERSIONAPI_KEY` is not set for it), `base_url_suffix` (appended to the
mock's URL, such as `"/"`), `max_retries`, `timeout_seconds`. Otherwise use the top-level `key`
(`test-key`), the mock's URL, and the defaults. Always install a sleep hook that records each
requested wait in seconds and returns at once.

**`files`**: a list of input descriptors. Pass exactly one as a single input, several as a list,
and an empty list as an empty list. When a case has no `files` key, call without files at all
(omit the argument, or pass null/nil where the language has no optional arguments).

| Descriptor | Pass to the SDK as |
|---|---|
| `{"path": "hello.txt"}` | A filesystem path to `fixtures/hello.txt`. |
| `{"bytes": "hello.txt", "name": "notes.txt"}` | The fixture's bytes in memory, with that name (no `name`: don't pass one). |
| `{"stream": "hello.txt", "name": "stream.txt"}` | A stream or reader over the fixture's bytes, with that name. |
| `{"bytes_utf8": "unicode\n", "name": "Résumé final (1).txt"}` | Those characters encoded as UTF-8, as bytes, with that name. |

**`params`**: pass as the params map. A value that is a descriptor object is a named file.
For `convert` and `stored_file_flow`, **always add `MockId`**: the case id plus a random suffix,
unique per run, so `attempts` can be read back.

**`options`**: `file_name` and `store_file`, passed as the SDK's typed options.

**`call`**: `convert`, `usage`, `conversions`, `delete_stored_file` (with `file_id`) or
`stored_file_flow` (below).

## Expectations

| Key | Check |
|---|---|
| `result.conversion_cost` | Equals. |
| `result.request_id` | `true`: a non-empty string. |
| `result.files` | Same length. For each: `name`, `ext`, `size` equal; `data_fixture`: data equals that fixture's bytes; `data_utf8`: data equals those characters as UTF-8; `stored: true`: `url` and `file_id` are set and reading the data raises StoredFileError. |
| `echo` | Parse the first output's content as JSON (download it first if it was stored). `method`, `path`, `query`, `authorization` equal; `user_agent_prefix` and `content_type_prefix`: the header starts with it; `fields`: each listed field appears in `fields` in that relative order, matching every key given; `absent_fields`: no field has that exact name. |
| `error` | The call raises that canonical error type (SPEC.md section 9 maps the names). `status`, `message` (exact), `message_contains`, `retry_after` equal or match; `request_id`: `true` non-empty, `false` absent. |
| `attempts` | `GET /__mock/attempts/<MockId>` equals this after the call. |
| `min_sleeps` | The recorded waits: the same count, and each one at least the value listed. |
| `save_all` | `save_all` into a new empty folder; the folder then holds exactly these names with these contents. |
| `conversions` | `count` entries; the first one's fields equal `first`. |
| `usage` | Each field equals; the two date-times compare as instants. |
| `deleted` | The return value of `delete_stored_file`. |

**`stored_file_flow`**: run `convert` with the case's files and options, check `result`, then:
reading the data raises the `data_access_error` type; `download()` returns the
`download_fixture` bytes; `delete_stored_file(file_id)` returns `first_delete`, and again
returns `second_delete`; `download()` once more raises `download_after_delete_error`.
