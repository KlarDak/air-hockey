import { GOAL, H, MALLET_R, PUCK_R, W, clamp, reducedEffects, renderScale } from "./config";
import { SoundSystem } from "./audio";
import { ui } from "./ui";
import type { Difficulty, Disc, GameMode, GameState, NetworkRole, Particle, Puck, Snapshot } from "./types";

export class Game {
  state: GameState = "setup";
  role: NetworkRole = "solo";
  difficulty: Difficulty = "pro";
  mode: GameMode = "duel";
  score: [number, number] = [0, 0];
  player: Disc = this.disc(W / 2, H - 185);
  opponent: Disc = this.disc(W / 2, 185);
  alliedBots: Disc[] = [this.disc(W / 2, H - 135), this.disc(W * .68, H * .64)];
  enemyBots: Disc[] = [this.opponent, this.disc(W * .32, H * .36), this.disc(W * .68, H * .48)];
  puck: Puck = { x: W / 2, y: H / 2, vx: 3, vy: -7 };
  onGuestInput: ((x: number, y: number) => void) | null = null;
  onHostInput: ((x: number, y: number) => void) | null = null;

  private readonly ctx = ui.canvas.getContext("2d")!;
  private readonly board = document.createElement("canvas");
  private readonly boardCtx = this.board.getContext("2d")!;
  private particles: Particle[] = [];
  private flash = 0;
  private lastTime = 0;
  private lastRenderedAt = 0;
  private networkTarget: Snapshot | null = null;
  private networkTargetAt = 0;
  private lastGuestInputAt = 0;
  private jamFrames = 0;
  private releaseFrames = 0;
  private releasedMallet: Disc | null = null;
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
    ui.controls.hidden = next !== "playing" || this.role !== "solo";
    ui.soloMenu.hidden = this.role !== "solo";
  }

  setRole(role: NetworkRole): void { this.role = role; this.updateScore(); }
  setDifficulty(value: Difficulty): void { this.difficulty = value; }
  setMode(value: GameMode): void {
    this.mode = value;
    const teamMode = value === "three";
    ui.leagueLabel.textContent = teamMode ? "TEAM LEAGUE / 02" : "NEON LEAGUE / 01";
    ui.onlineButton.disabled = teamMode;
    ui.onlineButton.textContent = teamMode ? "Online match · 1 VS 1 only" : "Play online";
  }

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

  startNetwork(): void {
    this.score = [0, 0]; this.networkTarget = null; this.lastGuestInputAt = performance.now();
    this.updateScore(); this.resetPuck(false); this.setState("playing");
  }

  resetPuck(towardPlayer = Math.random() > .5): void {
    this.puck = { x: W / 2, y: H / 2, vx: (Math.random() - .5) * 5, vy: (towardPlayer ? 1 : -1) * (6.5 + Math.random() * 2) };
    this.player = this.disc(W / 2, H - 185);
    this.opponent = this.disc(W / 2, 185);
    this.alliedBots = [this.disc(W / 2, H - 135), this.disc(W * .68, H * .64)];
    this.enemyBots = [this.opponent, this.disc(W * .32, H * .36), this.disc(W * .68, H * .48)];
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

  movePlayer(event: PointerEvent): void {
    if (this.state !== "playing") return;
    const rect = ui.canvas.getBoundingClientRect();
    const x = clamp((event.clientX - rect.left) / rect.width * W, MALLET_R + 18, W - MALLET_R - 18);
    const minY = this.mode === "three" && this.role === "solo" ? MALLET_R + 24 : H / 2 + MALLET_R + 12;
    const y = clamp((event.clientY - rect.top) / rect.height * H, minY, H - MALLET_R - 22);
    if (this.role === "guest") {
      this.opponent.x = W - x;
      this.opponent.y = H - y;
      this.lastGuestInputAt = performance.now();
      this.onGuestInput?.(W - x, H - y);
    } else {
      this.player.x = x;
      this.player.y = y;
      if (this.role === "host") {
        this.lastGuestInputAt = performance.now();
        this.onHostInput?.(x, y);
      }
    }
  }

  frame = (time: number): void => {
    const dt = Math.min(1.8, (time - this.lastTime) / 16.67 || 1);
    this.lastTime = time;
    if (this.state === "playing" && this.role === "solo") this.update(dt);
    if (this.role !== "solo" && this.networkTarget) this.interpolateNetwork(time);
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

  private hitMallet(mallet: Disc, networkGrace = 0): void {
    const travelX = mallet.x - mallet.px, travelY = mallet.y - mallet.py;
    const travelLengthSq = travelX * travelX + travelY * travelY;
    const sweep = travelLengthSq
      ? clamp(((this.puck.x - mallet.px) * travelX + (this.puck.y - mallet.py) * travelY) / travelLengthSq, 0, 1)
      : 1;
    const contactX = mallet.px + travelX * sweep, contactY = mallet.py + travelY * sweep;
    const dx = this.puck.x - contactX, dy = this.puck.y - contactY;
    const distance = Math.hypot(dx, dy), minimum = PUCK_R + MALLET_R + networkGrace;
    if (!distance || distance >= minimum) return;
    const nx = dx / distance, ny = dy / distance;
    this.puck.x = contactX + nx * minimum;
    this.puck.y = contactY + ny * minimum;
    const mvx = travelX, mvy = travelY;
    const relative = (this.puck.vx - mvx) * nx + (this.puck.vy - mvy) * ny;
    if (relative < 0) { this.puck.vx -= 1.85 * relative * nx; this.puck.vy -= 1.85 * relative * ny; }
    this.puck.vx += mvx * .55; this.puck.vy += mvy * .55;
    const speed = Math.hypot(this.puck.vx, this.puck.vy);
    if (speed > 22) { this.puck.vx *= 22 / speed; this.puck.vy *= 22 / speed; }
    if (this.mode === "three" && this.role === "solo" && this.alliedBots.includes(mallet)) {
      const passX = this.player.x - this.puck.x;
      const passY = this.player.y - this.puck.y;
      const passDistance = Math.hypot(passX, passY) || 1;
      this.puck.vx = this.puck.vx * .22 + passX / passDistance * 12.5;
      this.puck.vy = this.puck.vy * .22 + passY / passDistance * 12.5;
    }
    this.sound.play("mallet");
  }

  private update(dt: number): void {
    const [tracking, maxSpeed] = this.difficulty === "rookie" ? [.055, 5.3] : this.difficulty === "legend" ? [.13, 9.4] : [.085, 7.2];
    const slow = Math.hypot(this.puck.vx, this.puck.vy) < 4.5;
    const side = this.puck.x < 120 || this.puck.x > W - 120;
    const targetX = this.puck.y < H * .64 ? this.puck.x + (side ? 0 : this.puck.vx * 8) : W / 2;
    const gap = slow ? 64 : side ? 74 : 85;
    const targetY = this.puck.y < H / 2 ? clamp(this.puck.y - gap, 95, H / 2 - 75) : 185;
    if (this.role === "solo") {
      if (this.mode === "three") this.updateTeams(dt, tracking, maxSpeed);
      else this.updateAi(dt, tracking, maxSpeed, targetX, targetY);
    }

    this.puck.x += this.puck.vx * dt; this.puck.y += this.puck.vy * dt;
    this.puck.vx *= Math.pow(.9992, dt); this.puck.vy *= Math.pow(.9992, dt);
    const activeMallets = this.mode === "three" && this.role === "solo"
      ? [this.player, ...this.alliedBots, ...this.enemyBots]
      : [this.player, this.opponent];
    for (const mallet of activeMallets) {
      if (this.releaseFrames > 0 && this.releasedMallet === mallet) continue;
      if (mallet === this.opponent && this.aiRetreatFrames > 0) continue;
      this.hitMallet(mallet, this.role === "host" && mallet === this.opponent ? 10 : 0);
    }
    this.resolveRails();
    this.resolveJam(dt);
    if (this.releaseFrames > 0) { this.releaseFrames = Math.max(0, this.releaseFrames - dt); if (!this.releaseFrames) this.releasedMallet = null; }
    if (this.aiRetreatFrames > 0) this.aiRetreatFrames = Math.max(0, this.aiRetreatFrames - dt);
    if (this.aiCornerCooldown > 0) this.aiCornerCooldown = Math.max(0, this.aiCornerCooldown - dt);
    if (this.puck.y < -PUCK_R * 1.5) this.goal(true);
    if (this.puck.y > H + PUCK_R * 1.5) this.goal(false);
    this.player.px = this.player.x; this.player.py = this.player.y;
    this.opponent.px = this.opponent.x; this.opponent.py = this.opponent.y;
    for (const bot of [...this.alliedBots, ...this.enemyBots]) { bot.px = bot.x; bot.py = bot.y; }
  }

  private updateAi(dt: number, tracking: number, maxSpeed: number, targetX: number, targetY: number): void {
    const cornerRetreat = this.aiRetreatFrames > 0;
    const jamRetreat = this.releaseFrames > 0 && this.releasedMallet === this.opponent;
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

  private updateTeams(dt: number, tracking: number, maxSpeed: number): void {
    const move = (bot: Disc, targetX: number, targetY: number, speedScale = 1): void => {
      const speed = maxSpeed * speedScale;
      const factor = tracking * (speedScale > 1 ? 1.15 : 1);
      bot.x += clamp((targetX - bot.x) * factor * dt, -speed * dt, speed * dt);
      bot.y += clamp((targetY - bot.y) * factor * dt, -speed * dt, speed * dt);
      bot.x = clamp(bot.x, MALLET_R + 18, W - MALLET_R - 18);
    };

    const [enemyKeeper, enemyMidfielder, enemyAttacker] = this.enemyBots;
    const enemyDanger = this.puck.y < H * .32;
    move(enemyKeeper, clamp(this.puck.x, W / 2 - GOAL * .55, W / 2 + GOAL * .55), enemyDanger ? this.puck.y + 78 : 135, .9);
    move(enemyMidfielder, this.puck.y < H * .78 ? this.puck.x : W * .35, this.puck.y < H * .78 ? this.puck.y - 82 : H * .37, .96);
    move(enemyAttacker, this.puck.x, this.puck.y - 70, 1.12);

    const [allyKeeper, allyMidfielder] = this.alliedBots;
    const allyDanger = this.puck.y > H * .68;
    move(allyKeeper, clamp(this.puck.x, W / 2 - GOAL * .55, W / 2 + GOAL * .55), allyDanger ? this.puck.y + 78 : H - 135, .88);
    const supportX = this.puck.x * .72 + this.player.x * .28;
    const supportY = this.puck.y + Math.sign(this.player.y - this.puck.y || 1) * 82;
    move(allyMidfielder, supportX, supportY, 1.02);

    for (const bot of [...this.enemyBots, ...this.alliedBots]) {
      bot.y = clamp(bot.y, MALLET_R + 24, H - MALLET_R - 22);
    }
    this.separateTeam(this.enemyBots, MALLET_R + 24, H - MALLET_R - 22);
    this.separateTeam(this.alliedBots, MALLET_R + 24, H - MALLET_R - 22);
    for (const bot of this.alliedBots) this.pushBotAwayFromPlayer(bot);
  }

  private pushBotAwayFromPlayer(bot: Disc): void {
    let dx = bot.x - this.player.x, dy = bot.y - this.player.y;
    let distance = Math.hypot(dx, dy);
    const minimum = MALLET_R * 2 + 14;
    if (distance >= minimum) return;
    if (!distance) { dx = 1; dy = 0; distance = 1; }
    const push = minimum - distance;
    bot.x = clamp(bot.x + dx / distance * push, MALLET_R + 18, W - MALLET_R - 18);
    bot.y = clamp(bot.y + dy / distance * push, MALLET_R + 24, H - MALLET_R - 22);
  }

  private separateTeam(team: Disc[], minY: number, maxY: number): void {
    const minimum = MALLET_R * 2 + 14;
    for (let i = 0; i < team.length; i++) {
      for (let j = i + 1; j < team.length; j++) {
        const a = team[i], b = team[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance >= minimum) continue;
        if (!distance) { dx = 1; dy = 0; distance = 1; }
        const push = (minimum - distance) / 2;
        const nx = dx / distance, ny = dy / distance;
        a.x -= nx * push; a.y -= ny * push;
        b.x += nx * push; b.y += ny * push;
        a.x = clamp(a.x, MALLET_R + 18, W - MALLET_R - 18);
        b.x = clamp(b.x, MALLET_R + 18, W - MALLET_R - 18);
        a.y = clamp(a.y, minY, maxY); b.y = clamp(b.y, minY, maxY);
      }
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
    const mallets = this.mode === "three" && this.role === "solo"
      ? [this.player, ...this.alliedBots, ...this.enemyBots]
      : [this.player, this.opponent];
    const closest = mallets.reduce((best, mallet) =>
      Math.hypot(this.puck.x - mallet.x, this.puck.y - mallet.y) < Math.hypot(this.puck.x - best.x, this.puck.y - best.y) ? mallet : best);
    const closestDistance = Math.hypot(this.puck.x - closest.x, this.puck.y - closest.y);
    const touching = closestDistance < PUCK_R + MALLET_R + 10;
    this.jamFrames = this.releaseFrames > 0 ? 0 : (left || right || top || bottom) && touching ? this.jamFrames + dt : 0;
    if (this.jamFrames <= 20) return;
    this.releasedMallet = closest;
    this.releaseFrames = 20;
    if (left) { this.puck.x = PUCK_R + 26; this.puck.vx = Math.max(10, Math.abs(this.puck.vx)); }
    if (right) { this.puck.x = W - PUCK_R - 26; this.puck.vx = -Math.max(10, Math.abs(this.puck.vx)); }
    if (top) { this.puck.y = PUCK_R + 26; this.puck.vy = Math.max(10, Math.abs(this.puck.vy)); }
    if (bottom) { this.puck.y = H - PUCK_R - 26; this.puck.vy = -Math.max(10, Math.abs(this.puck.vy)); }
    if ((left || right) && Math.abs(this.puck.vy) < 4) this.puck.vy = this.puck.y < H / 2 ? 5 : -5;
    if ((top || bottom) && Math.abs(this.puck.vx) < 4) this.puck.vx = this.puck.x < W / 2 ? 5 : -5;
    this.jamFrames = 0;
  }

  private interpolateNetwork(time: number): void {
    const target = this.networkTarget!;
    const age = Math.min(2.5, (time - this.networkTargetAt) / 16.67);
    this.puck.x += (target.puck.x + target.puck.vx * age - this.puck.x) * .55;
    this.puck.y += (target.puck.y + target.puck.vy * age - this.puck.y) * .55;
    this.puck.vx = target.puck.vx; this.puck.vy = target.puck.vy;
    const ownsPlayer = this.role === "host";
    if (!ownsPlayer || time - this.lastGuestInputAt > 180) {
      this.player.x += (target.player.x - this.player.x) * .45;
      this.player.y += (target.player.y - this.player.y) * .45;
    }
    if (ownsPlayer || time - this.lastGuestInputAt > 180) {
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
    const playerColor = this.mode === "three" && this.role === "solo" ? "#5f82ff" : flip ? "#ff4d7d" : "#58f6d0";
    this.drawMallet(view(this.player), playerColor);
    if (this.mode === "three" && this.role === "solo") {
      for (const bot of this.alliedBots) this.drawMallet(view(bot), "#58f6d0");
      for (const bot of this.enemyBots) this.drawMallet(view(bot), "#ff4d7d");
    } else this.drawMallet(view(this.opponent), flip ? "#58f6d0" : "#ff4d7d");
    const x = flip ? W - this.puck.x : this.puck.x, y = flip ? H - this.puck.y : this.puck.y;
    this.ctx.save(); this.ctx.shadowBlur = reducedEffects ? 0 : 30; this.ctx.shadowColor = "#eff5ff"; this.ctx.fillStyle = "#eff5ff";
    this.ctx.beginPath(); this.ctx.arc(x, y, PUCK_R, 0, Math.PI * 2); this.ctx.fill(); this.ctx.restore();
    for (const p of this.particles) { this.ctx.globalAlpha = p.life; this.ctx.fillStyle = p.color; this.ctx.fillRect(flip ? W - p.x : p.x, flip ? H - p.y : p.y, 6, 6); }
    this.ctx.globalAlpha = 1;
    if (this.flash) { this.ctx.fillStyle = `rgba(255,255,255,${this.flash * .18})`; this.ctx.fillRect(0, 0, W, H); }
  }
}
