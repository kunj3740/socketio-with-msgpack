# MsgPackIO — SocketIO Binary Tester

A zero-dependency frontend for testing Socket.IO servers that use **MessagePack (Vec<u8>)** binary encoding — built for your Rust/socketioxide backend.

The **HTTP API tester** additionally speaks **Apache Arrow IPC**, so the same page can exercise both msgpack and Arrow endpoints.

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

### HTTP API Tester (MsgPack **or** Arrow)
- Pick a **BODY FORMAT** — `MSGPACK` or `ARROW`
- With `ARROW`, choose the IPC framing:
  - **FILE** — the Arrow *file* format, `ARROW1` magic, random access (default)
  - **STREAM** — the Arrow *stream* format, `0xFFFFFFFF` continuation framing
- The JSON payload is encoded to an Arrow IPC buffer and sent as the raw request body,
  with a live byte preview and the inferred **schema** (row/column counts + field types)
- Content-Type follows the format automatically
  (`application/vnd.apache.arrow.file` / `.stream`, or `application/x-msgpack`) —
  a hand-typed Content-Type is never overwritten
- Responses are **auto-detected**: Arrow (by IPC magic) -> MessagePack -> JSON -> raw text.
  Arrow responses are shown as decoded rows alongside their schema

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
| JSON → binary | MessagePack | `msgpack.encode()` (msgpack-lite) |
| Binary → JSON | MessagePack | `msgpack.decode()` (msgpack-lite) |
| JSON rows → binary | Arrow IPC | `Arrow.tableFromJSON()` + `Arrow.tableToIPC()` (apache-arrow) |
| Binary → JSON rows | Arrow IPC | `Arrow.tableFromIPC()` (apache-arrow) |
| Wire format | — | `Uint8Array` (Socket.IO binary event / HTTP body) |

Arrow support is **HTTP-only** — the Socket.IO emit/listen panels remain MessagePack + JSON.

Arrow `Int64` / `Timestamp` values decode to JavaScript `BigInt` / `Date`; both are
normalised to strings for display and for the COPY JSON button.

The encoding is fully compatible with Rust's `rmp` / `rmp-serde` crates used in your socketioxide backend.

## Tech Stack
- **AngularJS 1.8** — framework
- **Socket.IO 4.6** — transport
- **msgpack-lite 0.1** — MessagePack codec
- **apache-arrow 17** — Arrow IPC codec (HTTP API tester)
- All loaded from CDN, works offline-compatible once cached
