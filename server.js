#!/usr/bin/env node
/* Neon Serpent LAN — zero-dependency game server.
 * Serves snake.html and relays JSON messages between players over WebSockets.
 * The host's browser tab runs the authoritative game; this server only
 * manages rooms and forwards messages.   Usage:  node server.js   (PORT=8088)
 */
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const PORT = parseInt(process.env.PORT || "8088", 10);
const ROOT = __dirname;
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/* ---------------- minimal WebSocket (RFC6455, text frames) ---------------- */
let nextId = 1;
class WS {
  constructor(sock) {
    this.sock = sock; this.id = nextId++; this.buf = Buffer.alloc(0);
    this.closed = false; this.room = null;
    sock.setNoDelay(true);
    sock.on("data", (d) => this._feed(d));
    sock.on("end", () => this.destroy());      // FIN from peer (browser close)
    sock.on("error", () => this.destroy());
    sock.on("close", () => this.destroy());
  }
  _feed(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const f = this._parse();
      if (!f) return;
      this.buf = this.buf.subarray(f.len);
      if (f.op === 1) this.onText && this.onText(f.payload.toString("utf8"));
      else if (f.op === 8) { this._raw(0x88, f.payload); this.destroy(); return; }
      else if (f.op === 9) this._raw(0x8a, f.payload);          // ping -> pong
    }
  }
  _parse() {
    const b = this.buf;
    if (b.length < 2) return null;
    const op = b[0] & 0x0f, masked = b[1] & 0x80;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return null; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) {
      if (b.length < 10) return null;
      const big = b.readBigUInt64BE(2);
      if (big > 16777216n) { this.destroy(); return null; }     // 16MB cap
      len = Number(big); off = 10;
    }
    let mask = null;
    if (masked) { if (b.length < off + 4) return null; mask = b.subarray(off, off + 4); off += 4; }
    if (b.length < off + len) return null;
    let payload = Buffer.from(b.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    return { op, payload, len: off + len };
  }
  _raw(finOp, payload) {
    if (this.closed) return;
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([finOp, len]);
    else if (len < 65536) { head = Buffer.allocUnsafe(4); head[0] = finOp; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.allocUnsafe(10); head[0] = finOp; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    try { this.sock.write(Buffer.concat([head, payload])); } catch (e) { this.destroy(); }
  }
  send(obj) { if (!this.closed) this._raw(0x81, Buffer.from(JSON.stringify(obj), "utf8")); }
  sendRaw(str) { if (!this.closed) this._raw(0x81, Buffer.from(str, "utf8")); }
  ping() { this._raw(0x89, Buffer.alloc(0)); }
  destroy() {
    if (this.closed) return;
    this.closed = true;
    try { this.sock.destroy(); } catch (e) {}
    this.onClose && this.onClose();
  }
}

/* ---------------- rooms ---------------- */
const rooms = new Map();   // code -> {code,title,max,inGame,host,members:Map(id->{ws,name}),created}
const wsOf  = new Map();   // id -> ws
function genCode() {
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (;;) {
    const c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join("");
    if (!rooms.has(c)) return c;
  }
}
function clean(s, n) { return String(s == null ? "" : s).replace(/[^\w \-.!?()']/g, "").trim().slice(0, n); }
function rosterOf(room) {
  const r = [[room.host.id, room.host.name || "Host"]];
  for (const [id, m] of room.members) r.push([id, m.name]);
  return r;
}
function roomList() {
  return [...rooms.values()].map((r) => ({
    code: r.code, title: r.title || "Snake Room", max: r.max || 4,
    count: r.members.size + 1, inGame: !!r.inGame, host: (r.host && r.host.name) || "?",
    memberIds: [r.host.id, ...r.members.keys()],
  }));
}
function _sh(a, b){ return crypto.createHash("sha1").update(a + "\x00" + b).digest("hex").slice(0, 8); }
let _last = new Map();
function logSend(dir, room, from, to, msgStr){
  let g = "?", brief = "";
  try { const d = JSON.parse(msgStr).d || {}; g = d.g || "?";
    brief = g === "chat" ? " m=" + JSON.stringify((d.m || "")).slice(0, 30) + (d.o !== undefined ? " o=" + d.o : "")
      : g === "st" ? " tick=" + d.tick + " players=" + ((d.players || []).length)
      : g === "lobby" || g === "join" || g === "start" || g === "welcome" ? " " + msgStr.replace(/[{}\s"]/g, "").slice(0, 60)
      : g === "dir" ? " v=" + (d.v || "")
      : "";
  } catch (e) {}
  const key = _sh(dir + "|" + from + ">" + to + "|" + g, brief);
  const prev = _last.get(key);
  const now = Date.now();
  if (prev && now - prev.t < 4000){ prev.n++; prev.t = now; return; }   // coalesce rapid identical sends
  if (prev && prev.n > 1) console.log(`   ..x${prev.n} more identical`);
  _last.set(key, { t: now, n: 1 });
  console.log(`[${room || "-"}] ${dir} ${from}->${to} g=${g}${brief}`);
}
function relay(room, from, msgStr, exceptId) {
  logSend("fanout", room.code, "bcast", "*", msgStr);
  if (room.host && room.host.id !== exceptId && !room.host.closed) room.host.sendRaw(msgStr);
  for (const [id, m] of room.members) if (id !== exceptId && !m.ws.closed) m.ws.sendRaw(msgStr);
}
function deleteRoom(room, notify) {
  rooms.delete(room.code);
  if (room.host) room.host.room = null;
  for (const [, m] of room.members) { m.ws.room = null; if (notify) m.ws.send({ t: "kicked" }); }
  room.members.clear();
}

/* ---------------- HTTP ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
function lanIP() {
  const ifs = os.networkInterfaces();
  for (const k of Object.keys(ifs)) for (const a of ifs[k] || []) if (a.family === "IPv4" && !a.internal) return a.address;
  return "127.0.0.1";
}
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/rooms") { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); return res.end(JSON.stringify(roomList())); }
  if (u.pathname === "/ip") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ ip: lanIP(), port: PORT })); }
  let p = u.pathname === "/" ? "/snake.html" : u.pathname;
  const file = path.join(ROOT, path.basename(path.normalize(p)));
  if (!file.startsWith(ROOT) || (path.basename(file) !== "snake.html" && path.basename(file) !== "favicon.ico")) {
    res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found");
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
});

/* ---------------- WS protocol ----------------
 * connect:      /ws?host=1&name=..&title=..&max=N        (create room)
 *               /ws?code=CODE&name=..                    (join room)
 *               /ws                                      (scanner: gets {t:"rooms"} once)
 * server->cl:   {t:"ok",id,code?,isHost?}  {t:"err",msg}  {t:"kicked"}  {t:"rooms",rooms:[…]}
 *               {from:<id>| "sys", d:{…}}                 game messages
 * client->srv:  {to:<id>|"*"|"host", d:{…}}   {to:"sys",g:"close"|"leave"}
 * ---------------------------------------------- */
server.on("upgrade", (req, sock, head) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname !== "/ws") { sock.destroy(); return; }
  const key = req.headers["sec-websocket-key"];
  if (!key) { sock.destroy(); return; }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n");
  const ws = new WS(sock);
  wsOf.set(ws.id, ws);
  console.log(`[conn] id=${ws.id} role=${u.searchParams.get("host") ? "HOST" : u.searchParams.get("code") ? "CLIENT(" + clean(u.searchParams.get("code"), 8).toUpperCase() + ")" : "SCAN"} ua="${(req.headers["user-agent"] || "?").slice(0, 70)}"`);

  /* hello arrives in the connect query string */
  const q = u.searchParams;
  if (q.get("host")) {
    ws.name = clean(q.get("name"), 16) || ("Host" + ws.id);
    const code = genCode();
    rooms.set(code, {
      code, title: clean(q.get("title"), 28) || (ws.name + "'s room"),
      max: Math.min(8, Math.max(2, (q.get("max") | 0) || 4)),
      inGame: false, host: ws, members: new Map(), created: Date.now(),
    });
    ws.room = code;
    ws.send({ t: "ok", id: ws.id, code, isHost: 1 });
    console.log(`[room ${code}] opened by ${ws.name}`);
  } else if (q.get("code")) {
    const code = clean(q.get("code"), 8).toUpperCase();
    const room = rooms.get(code);
    if (!room) { ws.send({ t: "err", msg: "Room " + code + " not found" }); sock.end(); return; }
    if (room.members.size + 1 >= room.max) { ws.send({ t: "err", msg: "Room is full" }); sock.end(); return; }
    ws.name = clean(q.get("name"), 16) || ("Player" + ws.id);
    room.members.set(ws.id, { ws, name: ws.name });
    ws.room = room.code;
    ws.send({ t: "ok", id: ws.id, code, isHost: 0 });
    ws.send({ t: "joined", from: "sys", d: { g: "joined", code, host: room.host.id, roster: rosterOf(room) } });
    room.host.send({ from: ws.id, d: { g: "join", id: ws.id, name: ws.name } });
    console.log(`[room ${code}] ${ws.name} joined (${room.members.size + 1}/${room.max})`);
  } else {
    ws.send({ t: "rooms", rooms: roomList() });   // scanner; stays silent after
  }

  ws.onText = (txt) => {
    let m; try { m = JSON.parse(txt); } catch (e) { console.log(`[${ws.room || "-"}] <-id${ws.id} DROP: not JSON`); return; }
    if (!m || typeof m.to === "undefined") { console.log(`[${ws.room || "-"}] <-id${ws.id} DROP: no .to field`); return; }
    const room = rooms.get(ws.room);
    if (!room && m.to !== "sys") console.log(`[-] <-id${ws.id} DROP: msg g=${(m.d||{}).g || m.t || "?"} but ws has NO room (ws.room=${ws.room})`);
    if (m.to === "sys") {
      if (!room) return;
      if (m.g === "close" && room.host === ws) { console.log(`[room ${room.code}] closed`); deleteRoom(room, true); }
      else if (m.g === "leave" && room.host !== ws && room.members.has(ws.id)) {
        room.members.delete(ws.id); ws.room = null;
        room.host.send({ from: "sys", d: { g: "leave", id: ws.id } });
      }
      return;
    }
    if (!room) return;
    const str = JSON.stringify({ from: ws.id, d: m.d });
    if (m.d && m.d.g === "start" && room.host === ws) room.inGame = true;
    if (m.d && m.d.g === "back" && room.host === ws) room.inGame = false;
    if (m.to === "*") relay(room, ws, str, ws.id);
    else if (m.to === "host") {
      const ok = room.host && room.host !== ws && !room.host.closed;
      logSend(ok ? "to-host" : "DROP-no-host", room.code, "id" + ws.id, "host", str);
      if (ok) room.host.sendRaw(str);
    }
    else {
      const tgt = wsOf.get(m.to | 0);
      if (tgt && !tgt.closed && room.members.has(m.to | 0)) { logSend("to-id", room.code, "id" + ws.id, "id" + (m.to|0), str); tgt.sendRaw(str); }
      else if ((m.to | 0) === room.host.id && room.host !== ws && !room.host.closed) { logSend("to-host", room.code, "id" + ws.id, "host", str); room.host.sendRaw(str); }
      else logSend("DROP-nowhere", room.code, "id" + ws.id, "id" + (m.to|0), str);
    }
  };

  ws.onClose = () => {
    wsOf.delete(ws.id);
    const room = rooms.get(ws.room);
    if (!room) return;
    if (room.host === ws) { console.log(`[room ${room.code}] host gone`); deleteRoom(room, true); }
    else if (room.members.has(ws.id)) {
      room.members.delete(ws.id);
      room.host.send({ from: "sys", d: { g: "leave", id: ws.id } });
    }
  };
  if (head && head.length) sock.unshift(head);
});

setInterval(() => { for (const w of wsOf.values()) w.ping(); }, 25000).unref();
server.on("clientError", (e, sock) => { try { sock.destroy(); } catch (err) {} });

server.listen(PORT, "0.0.0.0", () => {
  console.log("Neon Serpent LAN server ready");
  console.log("  Local:   http://localhost:" + PORT);
  console.log("  Network: http://" + lanIP() + ":" + PORT + "   <- share this with other players on your LAN");
});
server.on("error", (e) => { if (e.code === "EADDRINUSE") console.error("Port " + PORT + " busy. Try: PORT=8089 node server.js"); else console.error(e.message); process.exit(1); });
