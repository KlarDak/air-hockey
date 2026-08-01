import { Game } from "./game";
import { SoundSystem } from "./audio";
import { ui } from "./ui";
import type { NetworkRole, PeerMessage, Snapshot, SoundKind } from "./types";

export class NetworkManager {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private roomPoll: number | null = null;
  private snapshotSequence = 0;
  private inputSequence = 0;
  private lastReceivedSnapshot = -1;
  private lastReceivedInput = -1;
  private lastInputSentAt = 0;

  constructor(private readonly game: Game, sound: SoundSystem) {
    sound.broadcast = kind => this.sendSound(kind);
    game.onGuestInput = (x, y) => this.sendInput(x, y);
    game.onHostSnapshot = snapshot => this.sendSnapshot(snapshot);
  }

  openMenu(): void {
    this.close();
    this.game.setRole("solo");
    document.querySelector("[data-role].active")?.classList.remove("active");
    ui.roomControls.hidden = true;
    ui.roomCode.value = "";
    ui.networkStatus.textContent = "Choose who creates the match";
    ui.setup.hidden = true;
    ui.network.hidden = false;
  }

  back(): void { this.close(); this.game.setRole("solo"); this.game.setState("setup"); }

  async chooseRole(role: Exclude<NetworkRole, "solo">): Promise<void> {
    this.game.setRole(role);
    this.game.sound.ensure();
    document.querySelector("[data-role].active")?.classList.remove("active");
    document.querySelector(`[data-role="${role}"]`)?.classList.add("active");
    this.stopPolling();
    ui.roomCode.value = "";
    ui.roomCode.readOnly = role === "host";
    ui.copyCode.disabled = true;
    ui.roomControls.hidden = false;
    ui.applyCode.hidden = role !== "guest";
    ui.copyCode.hidden = role !== "host";
    const connection = this.createPeer();
    if (role === "host") await this.createRoom(connection);
    else {
      connection.addEventListener("datachannel", event => this.bindChannel(event.channel), { once: true });
      ui.applyCode.disabled = true;
      ui.applyCode.textContent = "Join room";
      ui.networkStatus.textContent = "Enter the six-character code from the host";
      ui.roomCode.focus();
    }
  }

  async joinRoom(): Promise<void> {
    const code = ui.roomCode.value.trim().toUpperCase();
    if (!this.peer || code.length !== 6 || this.game.role !== "guest") return;
    ui.applyCode.disabled = true;
    try {
      ui.networkStatus.textContent = "Finding room…";
      const response = await fetch(`/api/rooms/${code}`);
      if (!response.ok) throw new Error("Room not found");
      const room = await response.json() as { offer: RTCSessionDescriptionInit };
      await this.peer.setRemoteDescription(room.offer);
      await this.peer.setLocalDescription(await this.peer.createAnswer());
      await this.waitForIce(this.peer);
      const answerResponse = await fetch(`/api/rooms/${code}/answer`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer: this.peer.localDescription }),
      });
      if (!answerResponse.ok) throw new Error("Could not join room");
      ui.networkStatus.textContent = "Room found. Connecting…";
    } catch {
      ui.networkStatus.textContent = "Room not found or expired. Check the code";
      ui.applyCode.disabled = false;
    }
  }

  async copyCode(): Promise<void> {
    try { await navigator.clipboard.writeText(ui.roomCode.value); }
    catch { ui.roomCode.select(); document.execCommand("copy"); }
    ui.copyCode.textContent = "Copied";
    window.setTimeout(() => ui.copyCode.textContent = "Copy room code", 1200);
  }

  close(): void {
    this.stopPolling();
    this.peer?.close();
    this.peer = null;
    this.channel = null;
  }

  private async createRoom(connection: RTCPeerConnection): Promise<void> {
    ui.networkStatus.textContent = "Creating a six-character room…";
    this.bindChannel(connection.createDataChannel("air-hockey", { ordered: false, maxRetransmits: 0 }));
    await connection.setLocalDescription(await connection.createOffer());
    await this.waitForIce(connection);
    const response = await fetch("/api/rooms", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offer: connection.localDescription }),
    });
    if (!response.ok) throw new Error("Could not create room");
    const data = await response.json() as { code: string };
    ui.roomCode.value = data.code;
    ui.copyCode.disabled = false;
    ui.networkStatus.textContent = "Send this code to player 2. Waiting for connection…";
    this.roomPoll = window.setInterval(async () => {
      if (!this.peer || this.peer.remoteDescription) return;
      const check = await fetch(`/api/rooms/${data.code}`);
      if (!check.ok) return;
      const room = await check.json() as { answer: RTCSessionDescriptionInit | null };
      if (room.answer) {
        await this.peer.setRemoteDescription(room.answer);
        this.stopPolling();
        ui.networkStatus.textContent = "Player found. Connecting…";
      }
    }, 700);
  }

  private createPeer(): RTCPeerConnection {
    this.peer?.close();
    const connection = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    connection.addEventListener("connectionstatechange", () => {
      if (connection.connectionState === "failed" || connection.connectionState === "disconnected") {
        ui.networkStatus.textContent = "Connection lost — create a fresh room to reconnect";
      }
    });
    this.peer = connection;
    return connection;
  }

  private bindChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.addEventListener("open", () => {
      this.snapshotSequence = this.inputSequence = 0;
      this.lastReceivedSnapshot = this.lastReceivedInput = -1;
      ui.networkStatus.textContent = "Connected — dropping the puck";
      this.game.sound.ensure();
      if (this.game.role === "host") this.game.start();
      else { this.game.resetPuck(); this.game.setState("playing"); }
    });
    channel.addEventListener("message", event => this.receive(JSON.parse(String(event.data)) as PeerMessage));
  }

  private receive(data: PeerMessage): void {
    if (data.type === "input" && this.game.role === "host") {
      if (data.seq <= this.lastReceivedInput) return;
      this.lastReceivedInput = data.seq;
      this.game.setRemoteOpponent(data.x, data.y);
    } else if (data.type === "sound" && this.game.role === "guest") {
      this.game.sound.play(data.kind, true);
    } else if (data.type === "snapshot" && this.game.role === "guest") {
      if (data.seq <= this.lastReceivedSnapshot) return;
      this.lastReceivedSnapshot = data.seq;
      this.game.applySnapshot(data);
    }
  }

  private sendInput(x: number, y: number): void {
    const now = performance.now();
    if (this.channel?.readyState !== "open" || now - this.lastInputSentAt < 16) return;
    this.channel.send(JSON.stringify({ type: "input", seq: this.inputSequence++, x, y } satisfies PeerMessage));
    this.lastInputSentAt = now;
  }

  private sendSnapshot(data: Omit<Snapshot, "type" | "seq">): void {
    if (this.channel?.readyState !== "open") return;
    this.channel.send(JSON.stringify({ type: "snapshot", seq: this.snapshotSequence++, ...data } satisfies Snapshot));
  }

  private sendSound(kind: SoundKind): void {
    if (this.game.role === "host" && this.channel?.readyState === "open") {
      this.channel.send(JSON.stringify({ type: "sound", kind } satisfies PeerMessage));
    }
  }

  private stopPolling(): void {
    if (this.roomPoll !== null) window.clearInterval(this.roomPoll);
    this.roomPoll = null;
  }

  private waitForIce(connection: RTCPeerConnection): Promise<void> {
    if (connection.iceGatheringState === "complete") return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => { connection.removeEventListener("icegatheringstatechange", check); resolve(); };
      const check = () => { if (connection.iceGatheringState === "complete") finish(); };
      connection.addEventListener("icegatheringstatechange", check);
      window.setTimeout(finish, 4500);
    });
  }
}
