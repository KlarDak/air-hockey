import { GOAL, H, MALLET_R, PUCK_R, W, clamp, reducedEffects, renderScale } from "./config";
import { SoundSystem } from "./audio";
import { ui } from "./ui";
import type { Difficulty, Disc, GameState, NetworkRole, Particle, Puck, Snapshot } from "./types";

export class Game {
  state: GameState = "setup";
  role: NetworkRole = "solo";
  difficulty: Difficulty = "pro";
  score: [number, number] = [0, 0];
  player: Disc = this.disc(W / 2, H - 185);
  opponent: Disc = this.disc(W / 2, 185);
  puck: Puck = { x: W / 2, y: H / 2, vx: 3, vy: -7 };
  onGuestInput: ((x: number, y: number) => void) | null = null;
  onHostSnapshot: ((snapshot: Omit<Snapshot, "type" | "seq">) => void) | null = null;

  private readonly ctx = ui.canvas.getContext("2d")!;
  private readonly board = document.createElement("canvas");
  private readonly boardCtx = this.board.getContext("2d")!;
  private particles: Particle[] = [];
  private flash = 0;
  private lastTime = 0;
  private lastRenderedAt = 0;
  private lastSnapshotAt = 0;
  private networkTarget: Snapshot | null = null;
  private networkTargetAt = 0;
  private lastGuestInputAt = 0;
  private jamFrames = 0;
  private releaseFrames = 0;
  private releasedMallet: "player" | "ai" | null = null;
  private aiRetreatFrames = 0;
  private aiCornerCooldown = 0;

  constructor(readonly sound: SoundSystem) {
    ui.canvas.width = Math.round(W * renderScale);
    ui.canvas.height = Math.round(H * renderScale);
    this.ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    this.board.width = Math.round(W * renderScale);
    this.board.height = Math.round(H * renderScale);
    this.boardCtx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
    this.renderBoard();
  }

  private disc(x: number, y: number): Disc { return { x, y, px: x, py: y }; }

  setState(next: GameState): void {
    this.state = next;
    ui.network.hidden = true;
    ui.setup.hidden = next !== "setup";
    ui.message.hidden = next !== "paused" && next !== "over";
    ui.controls.hidden = next !== "playing" || this.role === "guest";
    ui.soloMenu.hidden = this.role !== "solo";
  }

  setRole(role: NetworkRole): void { this.role = role; this.updateScore(); }
  setDifficulty(value: Difficulty): void { this.difficulty = value; }

  start(): void {
    this.sound.ensure();
    this.score = [0, 0];
    this.updateScore();
    ui.menu.hidden = true;
    ui.resume.hidden = false;
    ui.resume.textContent = "Back to ice";
    this.resetPuck(false);
    this.setState("playing");
  }

  resetPuck(towardPlayer = Math.random() > .5): void {
    this.puck = { x: W / 2, y: H / 2, vx: (Math.random() - .5) * 5, vy: (towardPlayer ? 1 : -1) * (6.5 + Math.random() * 2) };
    this.player = this.disc(W / 2, H - 185);
    this.opponent = this.disc(W / 2, 185);
    this.jamFrames = this.releaseFrames = this.aiRetreatFrames = this.aiCornerCooldown = 0;
    this.releasedMallet = null;
  }

  applySnapshot(snapshot: Snapshot): void {
    const first = !this.networkTarget;
    this.networkTarget = snapshot;
    this.networkTargetAt = performance.now();
    this.score = snapshot.score;
    if (first) {
      this.player = { ...snapshot.player };
      this.opponent = { ...snapshot.opponent };
      this.puck = { ...snapshot.puck };
    } else if (Math.hypot(snapshot.puck.x - this.puck.x, snapshot.puck.y - this.puck.y) > 220) {
      this.puck = { ...snapshot.puck };
    }
    this.updateScore();
    if (snapshot.state !== this.state) {
      this.setState(snapshot.state);
      if (snapshot.state === "over") {
        ui.label.textContent = `FINAL SCORE / ${this.score[1]}:${this.score[0]}`;
        ui.title.textContent = this.score[1] >= 7 ? "YOU OWN THE ICE" : "REMATCH?";
        ui.resume.hidden = ui.menu.hidden = true;
      }
    }
  }

  setRemoteOpponent(x: number, y: number): void {
    this.opponent.x = clamp(x, MALLET_R + 18, W - MALLET_R - 18);
    this.opponent.y = clamp(y, MALLET_R + 24, H / 2 - MALLET_R - 12);
  }

  movePlayer(event: PointerEvent): void {
    if (this.state !== "playing") return;
    const rect = ui.canvas.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / rect.width * W, MALLET_R + 18, W - MALLET_R - 18);
    const y = clamp((event.clientY - rect.top) / rect.height * H, H / 2 + MALLET_R + 12, H - MALLET_R - 22);
    if (this.role === "guest") {
      this.opponent.x = W - x;
      this.opponent.y = H - y;
      this.lastGuestInputAt = performance.now();
      this.onGuestInput?.(W - x, H - y);
    } else {
      this.player.x = x;
      this.player.y = y;
    }
  }

  frame = (time: number): void => {
    const dt = Math.min(1.8, (time - this.lastTime) / 16.67 || 1);
    this.lastTime = time;
    if (this.state === "playing" && this.role !== "guest") this.update(dt);
    if (this.role === "guest" && this.networkTarget) this.interpolateGuest(time);
    if (this.role === "host" && time - this.lastSnapshotAt > (reducedEffects ? 15 : 30)) {
      this.onHostSnapshot?.({ state: this.state, score: this.score, player: this.player, opponent: this.opponent, puck: this.puck });
      this.lastSnapshotAt = time;
    }
    for (const p of this.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += .12 * dt; p.life -= .018 * dt; }
    this.particles = this.particles.filter(p => p.life > 0);
    this.flash = Math.max(0, this.flash - .035 * dt);
    if (!reducedEffects || time - this.lastRenderedAt >= 16) { this.draw(); this.lastRenderedAt = time; }
    requestAnimationFrame(this.frame);
  };

  private updateScore(): void {
    ui.playerScore.textContent = String(this.role === "guest" ? this.score[1] : this.score[0]);
    ui.aiScore.textContent = String(this.role === "guest" ? this.score[0] : this.score[1]);
  }

  private burst(y: number, color: string): void {
    for (let i = 0; i < (reducedEffects ? 18 : 46); i++) {
      const angle = Math.random() * Math.PI * 2, speed = 2 + Math.random() * 9;
      this.particles.push({ x: W / 2, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, color });
    }
  }

  private goal(playerScored: boolean): void {
    this.sound.play("goal");
    this.score[playerScored ? 0 : 1]++;
    this.updateScore();
    this.flash = 1;
    this.burst(playerScored ? 30 : H - 30, playerScored ? "#58f6d0" : "#ff4d7d");
    if (this.score[playerScored ? 0 : 1] >= 7) {
      ui.label.textContent = `FINAL SCORE / ${this.score[0]}:${this.score[1]}`;
      ui.title.textContent = playerScored ? "YOU OWN THE ICE" : "REMATCH?";
      ui.resume.textContent = "Play again";
      ui.menu.hidden = false;
      this.setState("over");
    } else this.resetPuck(playerScored);
  }

  private hitMallet(mallet: Disc): void {
    const dx = this.puck.x - mallet.x, dy = this.puck.y - mallet.y;
    const distance = Math.hypot(dx, dy), minimum = PUCK_R + MALLET_R;
    if (!distance || distance >= minimum) return;
    const nx = dx / distance, ny = dy / distance;
    this.puck.x = mallet.x + nx * minimum;
    this.puck.y = mallet.y + ny * minimum;
    const mvx = mallet.x - mallet.px, mvy = mallet.y - mallet.py;
    const relative = (this.puck.vx - mvx) * nx + (this.puck.vy - mvy) * ny;
    if (relative < 0) { this.puck.vx -= 1.85 * relative * nx; this.puck.vy -= 1.85 * relative * ny; }
    this.puck.vx += mvx * .55; this.puck.vy += mvy * .55;
    const speed = Math.hypot(this.puck.vx, this.puck.vy);
    if (speed > 22) { this.puck.vx *= 22 / speed; this.puck.vy *= 22 / speed; }
    this.sound.play("mallet");
  }

  private update(dt: number): void {
    const [tracking, maxSpeed] = this.difficulty === "rookie" ? [.055, 5.3] : this.difficulty === "legend" ? [.13, 9.4] : [.085, 7.2];
    const slow = Math.hypot(this.puck.vx, this.puck.vy) < 4.5;
    const side = this.puck.x < 120 || this.puck.x > W - 120;
    const targetX = this.puck.y < H * .64 ? this.puck.x + (side ? 0 : this.puck.vx * 8) : W / 2;
    const gap = slow ? 64 : side ? 74 : 85;
    const targetY = this.puck.y < H / 2 ? clamp(this.puck.y - gap, 95, H / 2 - 75) : 185;
    if (this.role === "solo") this.updateAi(dt, tracking, maxSpeed, targetX, targetY);

    this.puck.x += this.puck.vx * dt; this.puck.y += this.puck.vy * dt;
    this.puck.vx *= Math.pow(.9992, dt); this.puck.vy *= Math.pow(.9992, dt);
    if (!(this.releaseFrames > 0 && this.releasedMallet === "player")) this.hitMallet(this.player);
    if (!(this.releaseFrames > 0 && this.releasedMallet === "ai") && this.aiRetreatFrames <= 0) this.hitMallet(this.opponent);
    this.resolveRails();
    this.resolveJam(dt);
    if (this.releaseFrames > 0) { this.releaseFrames = Math.max(0, this.releaseFrames - dt); if (!this.releaseFrames) this.releasedMallet = null; }
    if (this.aiRetreatFrames > 0) this.aiRetreatFrames = Math.max(0, this.aiRetreatFrames - dt);
    if (this.aiCornerCooldown > 0) this.aiCornerCooldown = Math.max(0, this.aiCornerCooldown - dt);
    if (this.puck.y < -PUCK_R * 1.5) this.goal(true);
    if (this.puck.y > H + PUCK_R * 1.5) this.goal(false);
    this.player.px = this.player.x; this.player.py = this.player.y;
    this.opponent.px = this.opponent.x; this.opponent.py = this.opponent.y;
  }

  private updateAi(dt: number, tracking: number, maxSpeed: number, targetX: number, targetY: number): void {
    const cornerRetreat = this.aiRetreatFrames > 0;
    const jamRetreat = this.releaseFrames > 0 && this.releasedMallet === "ai";
    const x = cornerRetreat ? (this.puck.x < W / 2 ? 190 : W - 190) : jamRetreat ? W / 2 : targetX;
    const y = cornerRetreat ? 220 : jamRetreat ? 205 : targetY;
    const factor = cornerRetreat || jamRetreat ? .18 : tracking;
    const speed = cornerRetreat || jamRetreat ? 12 : maxSpeed;
    this.opponent.x += clamp((x - this.opponent.x) * factor * dt, -speed * dt, speed * dt);
    this.opponent.y += clamp((y - this.opponent.y) * factor * dt, -speed * dt, speed * dt);
    this.opponent.x = clamp(this.opponent.x, MALLET_R + 18, W - MALLET_R - 18);
    this.opponent.y = clamp(this.opponent.y, MALLET_R + 24, H / 2 - MALLET_R - 12);
    const inCorner = this.puck.y < 112 && (this.puck.x < 112 || this.puck.x > W - 112);
    const touching = Math.hypot(this.puck.x - this.opponent.x, this.puck.y - this.opponent.y) < PUCK_R + MALLET_R;
    if (this.aiCornerCooldown <= 0 && inCorner && touching) {
      this.aiRetreatFrames = 10; this.aiCornerCooldown = 30;
      this.puck.y = Math.max(this.puck.y, PUCK_R + 24); this.puck.vy = Math.max(8, Math.abs(this.puck.vy));
      if (this.puck.x < W / 2) { this.puck.x = Math.max(this.puck.x, PUCK_R + 24); this.puck.vx = Math.max(9, Math.abs(this.puck.vx)); }
      else { this.puck.x = Math.min(this.puck.x, W - PUCK_R - 24); this.puck.vx = -Math.max(9, Math.abs(this.puck.vx)); }
    }
  }

  private resolveRails(): void {
    if (this.puck.x < PUCK_R + 18) { this.puck.x = PUCK_R + 18; this.puck.vx = Math.abs(this.puck.vx); this.sound.play("rail"); }
    if (this.puck.x > W - PUCK_R - 18) { this.puck.x = W - PUCK_R - 18; this.puck.vx = -Math.abs(this.puck.vx); this.sound.play("rail"); }
    const inGoal = Math.abs(this.puck.x - W / 2) < GOAL / 2;
    if (!inGoal && this.puck.y < PUCK_R + 18) { this.puck.y = PUCK_R + 18; this.puck.vy = Math.abs(this.puck.vy); this.sound.play("rail"); }
    if (!inGoal && this.puck.y > H - PUCK_R - 18) { this.puck.y = H - PUCK_R - 18; this.puck.vy = -Math.abs(this.puck.vy); this.sound.play("rail"); }
  }

  private resolveJam(dt: number): void {
    const left = this.puck.x < PUCK_R + 60, right = this.puck.x > W - PUCK_R - 60;
    const top = this.puck.y < PUCK_R + 60, bottom = this.puck.y > H - PUCK_R - 60;
    const aiDistance = Math.hypot(this.puck.x - this.opponent.x, this.puck.y - this.opponent.y);
    const playerDistance = Math.hypot(this.puck.x - this.player.x, this.puck.y - this.player.y);
    const touching = Math.min(aiDistance, playerDistance) < PUCK_R + MALLET_R + 10;
    this.jamFrames = this.releaseFrames > 0 ? 0 : (left || right || top || bottom) && touching ? this.jamFrames + dt : 0;
    if (this.jamFrames <= 20) return;
    this.releasedMallet = aiDistance < playerDistance ? "ai" : "player";
    this.releaseFrames = 20;
    if (left) { this.puck.x = PUCK_R + 26; this.puck.vx = Math.max(10, Math.abs(this.puck.vx)); }
    if (right) { this.puck.x = W - PUCK_R - 26; this.puck.vx = -Math.max(10, Math.abs(this.puck.vx)); }
    if (top) { this.puck.y = PUCK_R + 26; this.puck.vy = Math.max(10, Math.abs(this.puck.vy)); }
    if (bottom) { this.puck.y = H - PUCK_R - 26; this.puck.vy = -Math.max(10, Math.abs(this.puck.vy)); }
    if ((left || right) && Math.abs(this.puck.vy) < 4) this.puck.vy = this.puck.y < H / 2 ? 5 : -5;
    if ((top || bottom) && Math.abs(this.puck.vx) < 4) this.puck.vx = this.puck.x < W / 2 ? 5 : -5;
    this.jamFrames = 0;
  }

  private interpolateGuest(time: number): void {
    const target = this.networkTarget!;
    const age = Math.min(2.5, (time - this.networkTargetAt) / 16.67);
    this.puck.x += (target.puck.x + target.puck.vx * age - this.puck.x) * .55;
    this.puck.y += (target.puck.y + target.puck.vy * age - this.puck.y) * .55;
    this.puck.vx = target.puck.vx; this.puck.vy = target.puck.vy;
    this.player.x += (target.player.x - this.player.x) * .45;
    this.player.y += (target.player.y - this.player.y) * .45;
    if (time - this.lastGuestInputAt > 180) {
      this.opponent.x += (target.opponent.x - this.opponent.x) * .2;
      this.opponent.y += (target.opponent.y - this.opponent.y) * .2;
    }
  }

  private drawMallet(mallet: Disc, color: string): void {
    this.ctx.save(); this.ctx.shadowBlur = reducedEffects ? 0 : 35; this.ctx.shadowColor = color; this.ctx.fillStyle = color;
    this.ctx.beginPath(); this.ctx.arc(mallet.x, mallet.y, MALLET_R, 0, Math.PI * 2); this.ctx.fill();
    this.ctx.shadowBlur = 0; this.ctx.fillStyle = "#09101e"; this.ctx.beginPath(); this.ctx.arc(mallet.x, mallet.y, MALLET_R - 12, 0, Math.PI * 2); this.ctx.fill();
    this.ctx.strokeStyle = color; this.ctx.lineWidth = 5; this.ctx.stroke(); this.ctx.restore();
  }

  private renderBoard(): void {
    const gradient = this.boardCtx.createLinearGradient(0, 0, 0, H);
    gradient.addColorStop(0, "#11112e"); gradient.addColorStop(.5, "#080b20"); gradient.addColorStop(1, "#071d27");
    this.boardCtx.fillStyle = gradient; this.boardCtx.fillRect(0, 0, W, H);
    this.boardCtx.strokeStyle = "rgba(255,255,255,.035)"; this.boardCtx.lineWidth = 1;
    for (let x = 30; x < W; x += 48) { this.boardCtx.beginPath(); this.boardCtx.moveTo(x, 0); this.boardCtx.lineTo(x, H); this.boardCtx.stroke(); }
    for (let y = 30; y < H; y += 48) { this.boardCtx.beginPath(); this.boardCtx.moveTo(0, y); this.boardCtx.lineTo(W, y); this.boardCtx.stroke(); }
    this.boardCtx.lineWidth = 5; this.boardCtx.strokeStyle = "rgba(118,137,255,.38)"; this.boardCtx.strokeRect(18, 18, W - 36, H - 36);
    this.boardCtx.beginPath(); this.boardCtx.moveTo(20, H / 2); this.boardCtx.lineTo(W - 20, H / 2); this.boardCtx.strokeStyle = "rgba(255,255,255,.2)"; this.boardCtx.stroke();
    this.boardCtx.beginPath(); this.boardCtx.arc(W / 2, H / 2, 112, 0, Math.PI * 2); this.boardCtx.stroke();
    this.boardCtx.lineWidth = 12; this.boardCtx.strokeStyle = "#ff4d7d"; this.boardCtx.beginPath(); this.boardCtx.moveTo(W / 2 - GOAL / 2, 20); this.boardCtx.lineTo(W / 2 + GOAL / 2, 20); this.boardCtx.stroke();
    this.boardCtx.strokeStyle = "#58f6d0"; this.boardCtx.beginPath(); this.boardCtx.moveTo(W / 2 - GOAL / 2, H - 20); this.boardCtx.lineTo(W / 2 + GOAL / 2, H - 20); this.boardCtx.stroke();
  }

  private draw(): void {
    this.ctx.drawImage(this.board, 0, 0, W, H);
    const flip = this.role === "guest";
    const view = (disc: Disc) => flip ? { ...disc, x: W - disc.x, y: H - disc.y } : disc;
    this.drawMallet(view(this.player), flip ? "#ff4d7d" : "#58f6d0");
    this.drawMallet(view(this.opponent), flip ? "#58f6d0" : "#ff4d7d");
    const x = flip ? W - this.puck.x : this.puck.x, y = flip ? H - this.puck.y : this.puck.y;
    this.ctx.save(); this.ctx.shadowBlur = reducedEffects ? 0 : 30; this.ctx.shadowColor = "#eff5ff"; this.ctx.fillStyle = "#eff5ff";
    this.ctx.beginPath(); this.ctx.arc(x, y, PUCK_R, 0, Math.PI * 2); this.ctx.fill(); this.ctx.restore();
    for (const p of this.particles) { this.ctx.globalAlpha = p.life; this.ctx.fillStyle = p.color; this.ctx.fillRect(flip ? W - p.x : p.x, flip ? H - p.y : p.y, 6, 6); }
    this.ctx.globalAlpha = 1;
    if (this.flash) { this.ctx.fillStyle = `rgba(255,255,255,${this.flash * .18})`; this.ctx.fillRect(0, 0, W, H); }
  }
}
