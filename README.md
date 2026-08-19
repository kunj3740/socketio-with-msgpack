# MsgPackIO — SocketIO Binary Tester

A zero-dependency frontend for testing Socket.IO servers that use **MessagePack (Vec<u8>)** binary encoding — built for your Rust/socketioxide backend.

The **HTTP API tester** speaks **plain JSON**, **MessagePack** and **Apache Arrow IPC**, with the request and response formats chosen independently.

## How to Run

Just open `index.html` in any browser. No build step, no npm install.

```
open index.html
```

Or serve via any static server:
```bash
npx serve .
# or
python3 -m http.server 8080
```

## Features

### HTTP API Tester (JSON / MsgPack / Arrow)

Request and response formats are set independently, so you can POST JSON and read Arrow
back, or POST Arrow and read JSON — whatever the endpoint under test actually does.

**REQUEST BODY FORMAT** — what gets sent:

| Option | Body | Content-Type |
|--------|------|--------------|
| `JSON` | the payload re-serialised as compact UTF-8 JSON | `application/json` |
| `MSGPACK` | `msgpack.encode()` output | `application/x-msgpack` |
| `ARROW` | an Arrow IPC buffer | `application/vnd.apache.arrow.file` / `.stream` |

Content-Type follows the selected format, but a **hand-typed Content-Type is never
overwritten**. Every format shows a live byte preview; Arrow additionally shows the
inferred schema (row/column counts + field types).

With `ARROW`, pick the IPC framing:
- **FILE** — the Arrow *file* format, `ARROW1` magic, random access (default)
- **STREAM** — the Arrow *stream* format, `0xFFFFFFFF` continuation framing

**RESPONSE FORMAT** — how the body is read back, and what goes in the `Accept` header:

| Option | Behaviour |
|--------|-----------|
| `AUTO` | Arrow (by IPC magic) -> MessagePack -> JSON -> raw text (default) |
| `JSON` | forced `JSON.parse` |
| `MSGPACK` | forced `msgpack.decode` |
| `ARROW` | forced `Arrow.tableFromIPC`, shown as decoded rows + schema |

A **forced** decoder that fails reports the failure and shows the raw body, rather than
quietly falling back — otherwise picking a format would tell you nothing. `AUTO` is the
one that chains.

> Arrow is columnar, so an Arrow payload must be a **JSON array of row objects**
> (a single object is sent as one row). A column that is `null` in every row can't be
> typed by Arrow and is dropped — the UI flags it when that happens.

### Emit Events
- Enter a **Socket.IO event name** (e.g. `message`, `join_room`)
- Write your **payload as JSON**
- It's live-encoded to **MessagePack** (`Vec<u8>`) with a real-time byte preview
- Click **SEND MSGPACK** — the binary buffer is emitted to the socket

### Listen Events
- Add any number of event names to listen for
- When a matching event fires, the raw `Vec<u8>` bytes are shown
- The bytes are decoded from **MessagePack → JSON** and displayed with syntax highlighting

## Encoding Details

| Direction | Format | Tool |
|-----------|--------|------|
| JSON → bytes | JSON | `JSON.stringify()` + `TextEncoder` |
| bytes → JSON | JSON | `TextDecoder` + `JSON.parse()` |
| JSON → binary | MessagePack | `msgpack.encode()` (msgpack-lite) |
| Binary → JSON | MessagePack | `msgpack.decode()` (msgpack-lite) |
| JSON rows → binary | Arrow IPC | `Arrow.tableFromJSON()` + `Arrow.tableToIPC()` (apache-arrow) |
| Binary → JSON rows | Arrow IPC | `Arrow.tableFromIPC()` (apache-arrow) |
| Wire format | — | `Uint8Array` (Socket.IO binary event / HTTP body) |

Format selection is **HTTP-only** — the Socket.IO emit/listen panels remain MessagePack + JSON.

Arrow `Int64` / `Timestamp` values decode to JavaScript `BigInt` / `Date`; both are
normalised to strings for display and for the COPY JSON button.

The encoding is fully compatible with Rust's `rmp` / `rmp-serde` crates used in your socketioxide backend.

## Tech Stack
- **AngularJS 1.8** — framework
- **Socket.IO 4.6** — transport
- **msgpack-lite 0.1** — MessagePack codec
- **apache-arrow 17** — Arrow IPC codec (HTTP API tester)
- All loaded from CDN, works offline-compatible once cached
