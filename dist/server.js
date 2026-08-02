// server.ts
import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { WebSocket, WebSocketServer } from "ws";
var host = process.env.HOST ?? "0.0.0.0";
var port = Number(process.env.PORT ?? 5173);
var root = process.cwd();
var alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
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
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
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
var server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
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
var sockets = new WebSocketServer({ server, path: "/socket", maxPayload: 256e3 });
sockets.on("connection", (rawSocket) => {
  const socket = rawSocket;
  socket.alive = true;
  socket.on("pong", () => {
    socket.alive = true;
  });
  socket.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
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
        socket.roomCode = code;
        socket.role = "guest";
        send(room.host, { type: "connected", role: "host" });
        send(socket, { type: "connected", role: "guest" });
        return;
      }
      if (message.type === "relay" && socket.roomCode) {
        const room = rooms.get(socket.roomCode);
        send(socket.role === "host" ? room?.guest : room?.host, { type: "relay", payload: message.payload });
      }
    } catch {
      send(socket, { type: "error", message: "Invalid server message" });
    }
  });
  socket.on("close", () => leave(socket));
  socket.on("error", () => leave(socket));
});
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
sockets.on("close", () => clearInterval(heartbeat));
server.listen(port, host, () => {
  console.log(`Air Hockey WebSocket server: http://${host}:${port}`);
  for (const addresses of Object.values(networkInterfaces())) for (const address of addresses ?? [])
    if (address.family === "IPv4" && !address.internal) console.log(`Network: http://${address.address}:${port}`);
});
//# sourceMappingURL=server.js.map
