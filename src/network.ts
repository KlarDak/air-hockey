import { Game } from "./game";
import { SoundSystem } from "./audio";
import { ui } from "./ui";
import type { NetworkRole, PeerMessage, Snapshot, SoundKind } from "./types";

type ServerMessage =
  | { type: "created"; code: string }
  | { type: "connected"; role: "host" | "guest" }
  | { type: "relay"; payload: PeerMessage }
  | { type: "peer-left" }
  | { type: "error"; message: string };

const socketUrl = new URL("socket", document.baseURI);
socketUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";

export class NetworkManager {
  private socket: WebSocket | null = null;
  private snapshotSequence = 0;
  private inputSequence = 0;
  private lastReceivedSnapshot = -1;
  private lastReceivedInput = -1;
  private lastInputSentAt = 0;
  private manuallyClosed = false;
  private matchConnected = false;

  constructor(private readonly game: Game, sound: SoundSystem) {
    sound.broadcast = kind => this.sendSound(kind);
    game.onGuestInput = (x, y) => this.sendInput(x, y);
    game.onHostSnapshot = snapshot => this.sendSnapshot(snapshot);
  }
  openMenu(): void {
    if (this.game.mode === "three") return;
    this.close(); this.game.setRole("solo");
    document.querySelector("[data-role].active")?.classList.remove("active");
    ui.roomControls.hidden = true; ui.roomCode.value = "";
    ui.networkStatus.textContent = "Choose who creates the match";
    ui.setup.hidden = true; ui.network.hidden = false;
  }
  back(): void { this.close(); this.game.setRole("solo"); this.game.setState("setup"); }
  async chooseRole(role: Exclude<NetworkRole, "solo">): Promise<void> {
    if (this.game.mode === "three") throw new Error("Direct Match supports 1 VS 1 only");
    this.close(); this.matchConnected = false; this.game.setRole(role); this.game.sound.ensure();
    document.querySelector("[data-role].active")?.classList.remove("active");
    document.querySelector(`[data-role="${role}"]`)?.classList.add("active");
    ui.roomCode.value = ""; ui.roomCode.readOnly = role === "host"; ui.copyCode.disabled = true;
    ui.roomControls.hidden = false; ui.applyCode.hidden = role !== "guest"; ui.copyCode.hidden = role !== "host";
    ui.applyCode.disabled = true; ui.networkStatus.textContent = "Connecting to game server…";
    await this.connect();
    if (role === "host") { this.send({ type: "create" }); ui.networkStatus.textContent = "Creating room…"; }
    else { ui.applyCode.textContent = "Join room"; ui.networkStatus.textContent = "Enter the six-character code from the host"; ui.roomCode.focus(); }
  }
  async joinRoom(): Promise<void> {
    const code = ui.roomCode.value.trim().toUpperCase();
    if (code.length !== 6 || this.game.role !== "guest") return;
    ui.applyCode.disabled = true; ui.networkStatus.textContent = "Joining room…";
    try {
      if (this.socket?.readyState !== WebSocket.OPEN) await this.connect();
      this.send({ type: "join", code });
    } catch (error) {
      ui.networkStatus.textContent = error instanceof Error ? error.message : "Could not reach game server";
      ui.applyCode.disabled = false;
    }
  }
  async copyCode(): Promise<void> {
    try { await navigator.clipboard.writeText(ui.roomCode.value); }
    catch { ui.roomCode.select(); document.execCommand("copy"); }
    ui.copyCode.textContent = "Copied"; window.setTimeout(() => ui.copyCode.textContent = "Copy room code", 1200);
  }
  close(): void { this.manuallyClosed = true; this.matchConnected = false; this.socket?.close(); this.socket = null; }
  private connect(): Promise<void> {
    this.manuallyClosed = false;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(socketUrl);
      const timeout = window.setTimeout(() => { socket.close(); reject(new Error("Game server connection timed out")); }, 8000);
      socket.addEventListener("open", () => { window.clearTimeout(timeout); this.socket = socket; resolve(); }, { once: true });
      socket.addEventListener("error", () => { window.clearTimeout(timeout); reject(new Error("Could not connect to game server")); }, { once: true });
      socket.addEventListener("message", event => this.handleServerMessage(JSON.parse(String(event.data)) as ServerMessage));
      socket.addEventListener("close", () => {
        const wasCurrent = this.socket === socket;
        if (wasCurrent) this.socket = null;
        if (wasCurrent && !this.manuallyClosed && this.game.role !== "solo") ui.networkStatus.textContent = "Game server connection lost";
      });
    });
  }
  private handleServerMessage(message: ServerMessage): void {
    if (message.type === "created") {
      ui.roomCode.value = message.code; ui.copyCode.disabled = false;
      ui.networkStatus.textContent = "Send this code to player 2. Waiting for connection…";
    } else if (message.type === "connected") {
      this.matchConnected = true;
      this.snapshotSequence = this.inputSequence = 0; this.lastReceivedSnapshot = this.lastReceivedInput = -1;
      ui.networkStatus.textContent = "Connected — dropping the puck"; this.game.sound.ensure();
      if (message.role === "host") this.game.start(); else { this.game.resetPuck(); this.game.setState("playing"); }
    } else if (message.type === "relay") this.receive(message.payload);
    else if (message.type === "peer-left") {
      this.matchConnected = false;
      ui.networkStatus.textContent = "Other player disconnected — create a fresh room";
    }
    else if (message.type === "error") { ui.networkStatus.textContent = message.message; ui.applyCode.disabled = false; }
  }
  private receive(data: PeerMessage): void {
    if (data.type === "input" && this.game.role === "host") {
      if (data.seq <= this.lastReceivedInput) return;
      this.lastReceivedInput = data.seq; this.game.setRemoteOpponent(data.x, data.y);
    } else if (data.type === "sound" && this.game.role === "guest") this.game.sound.play(data.kind, true);
    else if (data.type === "snapshot" && this.game.role === "guest") {
      if (data.seq <= this.lastReceivedSnapshot) return;
      this.lastReceivedSnapshot = data.seq; this.game.applySnapshot(data);
    }
  }
  private send(data: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("Game server is not connected");
    this.socket.send(JSON.stringify(data));
  }
  private relay(payload: PeerMessage): void {
    if (this.matchConnected && this.socket?.readyState === WebSocket.OPEN) this.send({ type: "relay", payload });
  }
  private sendInput(x: number, y: number): void {
    const now = performance.now(); if (now - this.lastInputSentAt < 16) return;
    this.relay({ type: "input", seq: this.inputSequence++, x, y }); this.lastInputSentAt = now;
  }
  private sendSnapshot(data: Omit<Snapshot, "type" | "seq">): void { this.relay({ type: "snapshot", seq: this.snapshotSequence++, ...data }); }
  private sendSound(kind: SoundKind): void { if (this.game.role === "host") this.relay({ type: "sound", kind }); }
}
