# MsgPackIO — SocketIO Binary Tester

A zero-dependency frontend for testing Socket.IO servers that use **MessagePack (Vec<u8>)** binary encoding — built for your Rust/socketioxide backend.

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

| Format | Tool |
|--------|------|
| JSON → binary | `msgpack.encode()` (msgpack-lite) |
| Binary → JSON | `msgpack.decode()` (msgpack-lite) |
| Wire format | `Uint8Array` (Socket.IO binary event) |

The encoding is fully compatible with Rust's `rmp` / `rmp-serde` crates used in your socketioxide backend.

## Tech Stack
- **AngularJS 1.8** — framework
- **Socket.IO 4.6** — transport
- **msgpack-lite 0.1** — MessagePack codec
- All loaded from CDN, works offline-compatible once cached
