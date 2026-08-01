import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { extname, join, normalize } from "node:path";
import { readFile, stat } from "node:fs/promises";

const host = "0.0.0.0";
const port = Number(process.env.PORT ?? 5173);
const root = process.cwd();
type Room = { offer: RTCSessionDescriptionInit; answer?: RTCSessionDescriptionInit; createdAt: number };
const rooms = new Map<string, Room>();
const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const roomLifetime = 10 * 60 * 1000;
const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function createRoomCode(): string {
  let code = "";
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

async function readJson(request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 128_000) throw new Error("Payload too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(response: import("node:http").ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const now = Date.now();
    for (const [code, room] of rooms) if (now - room.createdAt > roomLifetime) rooms.delete(code);

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      const body = await readJson(request);
      if (!body.offer || typeof body.offer !== "object") { sendJson(response, 400, { error: "Offer required" }); return; }
      const code = createRoomCode();
      rooms.set(code, { offer: body.offer as RTCSessionDescriptionInit, createdAt: now });
      sendJson(response, 201, { code }); return;
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})$/);
    if (request.method === "GET" && roomMatch) {
      const room = rooms.get(roomMatch[1]);
      if (!room) { sendJson(response, 404, { error: "Room not found" }); return; }
      sendJson(response, 200, { offer: room.offer, answer: room.answer ?? null }); return;
    }

    const answerMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]{6})\/answer$/);
    if (request.method === "POST" && answerMatch) {
      const room = rooms.get(answerMatch[1]);
      if (!room) { sendJson(response, 404, { error: "Room not found" }); return; }
      const body = await readJson(request);
      if (!body.answer || typeof body.answer !== "object") { sendJson(response, 400, { error: "Answer required" }); return; }
      room.answer = body.answer as RTCSessionDescriptionInit;
      sendJson(response, 200, { ok: true }); return;
    }

    const requested = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const filePath = normalize(join(root, requested));

    if (!filePath.startsWith(root) || !(await stat(filePath)).isFile()) {
      response.writeHead(404).end("Not found");
      return;
    }

    const content = await readFile(filePath);
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`Air Hockey is running:`);
  console.log(`  Local:   http://localhost:${port}`);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        console.log(`  Network: http://${address.address}:${port}`);
      }
    }
  }
});
