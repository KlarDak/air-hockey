// server.ts
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";
var host = process.env.HOST ?? "0.0.0.0";
var port = Number(process.env.PORT ?? 5173);
var root = process.cwd();
var W = 720;
var H = 1120;
var GOAL = 250;
var PUCK_R = 24;
var MALLET_R = 48;
var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
var clamp = (value, min, max) => Math.max(min, Math.min(max, value));
var mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};
var rooms = /* @__PURE__ */ new Map();
function send(socket, data) {
  if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 64e3) socket.send(JSON.stringify(data));
}
function relay(room, payload) {
  const message = { type: "relay", payload };
  send(room.host, message);
  send(room.guest, message);
}
function disc(x, y) {
  return { x, y, px: x, py: y };
}
function puck() {
  return { x: W / 2, y: H / 2, vx: (Math.random() - 0.5) * 5, vy: (Math.random() > 0.5 ? 1 : -1) * (6.5 + Math.random() * 2) };
}
function createMatch() {
  return { tick: 0, state: "playing", score: [0, 0], player: disc(W / 2, H - 185), opponent: disc(W / 2, 185), puck: puck() };
}
function createCode() {
  let code = "";
  do
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  while (rooms.has(code));
  return code;
}
function leave(socket) {
  if (!socket.roomCode) return;
  const room = rooms.get(socket.roomCode);
  if (!room) return;
  const peer = socket.role === "host" ? room.guest : room.host;
  send(peer, { type: "peer-left" });
  rooms.delete(socket.roomCode);
  if (peer) {
    peer.roomCode = void 0;
    peer.role = void 0;
  }
  socket.roomCode = void 0;
  socket.role = void 0;
}
function hitMallet(match, mallet) {
  const travelX = mallet.x - mallet.px, travelY = mallet.y - mallet.py;
  const lengthSq = travelX * travelX + travelY * travelY;
  const sweep = lengthSq ? clamp(((match.puck.x - mallet.px) * travelX + (match.puck.y - mallet.py) * travelY) / lengthSq, 0, 1) : 1;
  const contactX = mallet.px + travelX * sweep, contactY = mallet.py + travelY * sweep;
  const dx = match.puck.x - contactX, dy = match.puck.y - contactY;
  const distance = Math.hypot(dx, dy), minimum = PUCK_R + MALLET_R + 8;
  if (!distance || distance >= minimum) return false;
  const nx = dx / distance, ny = dy / distance;
  match.puck.x = contactX + nx * minimum;
  match.puck.y = contactY + ny * minimum;
  const relative = (match.puck.vx - travelX) * nx + (match.puck.vy - travelY) * ny;
  if (relative < 0) {
    match.puck.vx -= 1.85 * relative * nx;
    match.puck.vy -= 1.85 * relative * ny;
  }
  match.puck.vx += travelX * 0.55;
  match.puck.vy += travelY * 0.55;
  const speed = Math.hypot(match.puck.vx, match.puck.vy);
  if (speed > 22) {
    match.puck.vx *= 22 / speed;
    match.puck.vy *= 22 / speed;
  }
  return true;
}
function reset(match) {
  match.player = disc(W / 2, H - 185);
  match.opponent = disc(W / 2, 185);
  match.puck = puck();
}
function simulate(room) {
  const match = room.match;
  if (!match || match.state !== "playing" || !room.guest) return;
  const dt = 0.5;
  match.puck.x += match.puck.vx * dt;
  match.puck.y += match.puck.vy * dt;
  match.puck.vx *= Math.pow(0.9992, dt);
  match.puck.vy *= Math.pow(0.9992, dt);
  if (hitMallet(match, match.player) || hitMallet(match, match.opponent)) relay(room, { type: "sound", kind: "mallet" });
  const inGoal = Math.abs(match.puck.x - W / 2) < GOAL / 2;
  let rail = false;
  if (match.puck.x < PUCK_R + 18) {
    match.puck.x = PUCK_R + 18;
    match.puck.vx = Math.abs(match.puck.vx);
    rail = true;
  }
  if (match.puck.x > W - PUCK_R - 18) {
    match.puck.x = W - PUCK_R - 18;
    match.puck.vx = -Math.abs(match.puck.vx);
    rail = true;
  }
  if (!inGoal && match.puck.y < PUCK_R + 18) {
    match.puck.y = PUCK_R + 18;
    match.puck.vy = Math.abs(match.puck.vy);
    rail = true;
  }
  if (!inGoal && match.puck.y > H - PUCK_R - 18) {
    match.puck.y = H - PUCK_R - 18;
    match.puck.vy = -Math.abs(match.puck.vy);
    rail = true;
  }
  if (rail) relay(room, { type: "sound", kind: "rail" });
  let scored = -1;
  if (match.puck.y < -PUCK_R * 1.5) scored = 0;
  if (match.puck.y > H + PUCK_R * 1.5) scored = 1;
  if (scored >= 0) {
    match.score[scored]++;
    relay(room, { type: "sound", kind: "goal" });
    if (match.score[scored] >= 7) match.state = "over";
    else reset(match);
  }
  match.player.px = match.player.x;
  match.player.py = match.player.y;
  match.opponent.px = match.opponent.x;
  match.opponent.py = match.opponent.y;
  match.tick++;
  if (match.tick % 2 === 0 || scored >= 0) relay(room, { type: "snapshot", seq: match.tick, state: match.state, score: match.score, player: match.player, opponent: match.opponent, puck: match.puck });
}
var server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size, tickRate: 120 }));
      return;
    }
    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const filePath = normalize(join(root, requested));
    if (!filePath.startsWith(root) || !(await stat(filePath)).isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }
    const content = await readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(content);
  } catch {
    response.writeHead(404).end("Not found");
  }
});
var sockets = new WebSocketServer({ server, path: "/socket", maxPayload: 64e3 });
sockets.on("connection", (rawSocket) => {
  const socket = rawSocket;
  socket.alive = true;
  socket.on("pong", () => {
    socket.alive = true;
  });
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.type === "ping") {
        send(socket, { type: "pong", sentAt: message.sentAt });
        return;
      }
      if (message.type === "create") {
        leave(socket);
        const code = createCode();
        socket.roomCode = code;
        socket.role = "host";
        rooms.set(code, { host: socket });
        send(socket, { type: "created", code });
        return;
      }
      if (message.type === "join") {
        const code = String(message.code ?? "").trim().toUpperCase();
        const room = rooms.get(code);
        if (!room || room.guest || room.host.readyState !== WebSocket.OPEN) {
          send(socket, { type: "error", message: "Room not found or already full" });
          return;
        }
        leave(socket);
        room.guest = socket;
        room.match = createMatch();
        socket.roomCode = code;
        socket.role = "guest";
        send(room.host, { type: "connected", role: "host" });
        send(socket, { type: "connected", role: "guest" });
        return;
      }
      if (message.type === "relay" && message.payload?.type === "input" && socket.roomCode) {
        const room = rooms.get(socket.roomCode), match = room?.match;
        const x = Number(message.payload.x), y = Number(message.payload.y);
        if (!match || !Number.isFinite(x) || !Number.isFinite(y)) return;
        const target = socket.role === "host" ? match.player : match.opponent;
        target.x = clamp(x, MALLET_R + 18, W - MALLET_R - 18);
        target.y = socket.role === "host" ? clamp(y, H / 2 + MALLET_R + 12, H - MALLET_R - 22) : clamp(y, MALLET_R + 24, H / 2 - MALLET_R - 12);
      }
    } catch {
      send(socket, { type: "error", message: "Invalid server message" });
    }
  });
  socket.on("close", () => leave(socket));
  socket.on("error", () => leave(socket));
});
var gameLoop = setInterval(() => {
  for (const room of rooms.values()) simulate(room);
}, 1e3 / 120);
var heartbeat = setInterval(() => {
  for (const rawSocket of sockets.clients) {
    const socket = rawSocket;
    if (socket.alive === false) {
      socket.terminate();
      continue;
    }
    socket.alive = false;
    socket.ping();
  }
}, 3e4);
sockets.on("close", () => {
  clearInterval(gameLoop);
  clearInterval(heartbeat);
});
server.listen(port, host, () => {
  console.log(`Air Hockey authoritative server: http://${host}:${port} (120 Hz)`);
  for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? [])
    if (address.family === "IPv4" && !address.internal) console.log(`Network: http://${address.address}:${port}`);
});
//# sourceMappingURL=server.js.map
