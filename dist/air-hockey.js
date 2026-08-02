"use strict";
(() => {
  // src/audio.ts
  var SoundSystem = class {
    context = null;
    lastContact = 0;
    broadcast = null;
    ensure() {
      this.context ??= new AudioContext();
      if (this.context.state === "suspended") void this.context.resume();
      return this.context;
    }
    play(kind, remote = false) {
      const now = performance.now();
      if (kind !== "goal" && now - this.lastContact < 38) return;
      if (kind !== "goal") this.lastContact = now;
      const context = this.ensure();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const startAt = context.currentTime;
      const settings = kind === "mallet" ? { frequency: 175, end: 92, volume: 0.105, duration: 0.075, wave: "square" } : kind === "rail" ? { frequency: 520, end: 290, volume: 0.055, duration: 0.045, wave: "triangle" } : { frequency: 220, end: 720, volume: 0.13, duration: 0.3, wave: "sine" };
      oscillator.type = settings.wave;
      oscillator.frequency.setValueAtTime(settings.frequency, startAt);
      oscillator.frequency.exponentialRampToValueAtTime(settings.end, startAt + settings.duration);
      gain.gain.setValueAtTime(settings.volume, startAt);
      gain.gain.exponentialRampToValueAtTime(1e-4, startAt + settings.duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + settings.duration);
      if (!remote) this.broadcast?.(kind);
    }
  };

  // src/config.ts
  var W = 720;
  var H = 1120;
  var GOAL = 250;
  var PUCK_R = 24;
  var MALLET_R = 48;
  var reducedEffects = matchMedia("(pointer: coarse)").matches || (navigator.hardwareConcurrency ?? 8) <= 4;
  var renderScale = reducedEffects ? 0.5 : 1;
  var clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  // src/ui.ts
  var get = (selector) => document.querySelector(selector);
  var ui = {
    canvas: get("#game"),
    leagueLabel: get("#league-label"),
    onlineButton: get("#online"),
    setup: get("#setup"),
    message: get("#message"),
    controls: get("#controls"),
    playerScore: get("#player-score"),
    aiScore: get("#ai-score"),
    title: get("#message-title"),
    label: get("#message-label"),
    resume: get("#resume"),
    menu: get("#menu"),
    network: get("#network"),
    networkStatus: get("#network-status"),
    roomCode: get("#room-code"),
    applyCode: get("#apply-code"),
    copyCode: get("#copy-code"),
    roomControls: get("#room-controls"),
    soloMenu: get("#solo-menu")
  };

  // src/game.ts
  var Game = class {
    constructor(sound2) {
      this.sound = sound2;
      ui.canvas.width = Math.round(W * renderScale);
      ui.canvas.height = Math.round(H * renderScale);
      this.ctx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
      this.board.width = Math.round(W * renderScale);
      this.board.height = Math.round(H * renderScale);
      this.boardCtx.setTransform(renderScale, 0, 0, renderScale, 0, 0);
      this.renderBoard();
    }
    state = "setup";
    role = "solo";
    difficulty = "pro";
    mode = "duel";
    score = [0, 0];
    player = this.disc(W / 2, H - 185);
    opponent = this.disc(W / 2, 185);
    alliedBots = [this.disc(W / 2, H - 135), this.disc(W * 0.68, H * 0.64)];
    enemyBots = [this.opponent, this.disc(W * 0.32, H * 0.36), this.disc(W * 0.68, H * 0.48)];
    puck = { x: W / 2, y: H / 2, vx: 3, vy: -7 };
    onGuestInput = null;
    onHostSnapshot = null;
    ctx = ui.canvas.getContext("2d");
    board = document.createElement("canvas");
    boardCtx = this.board.getContext("2d");
    particles = [];
    flash = 0;
    lastTime = 0;
    lastRenderedAt = 0;
    lastSnapshotAt = 0;
    networkTarget = null;
    networkTargetAt = 0;
    lastGuestInputAt = 0;
    jamFrames = 0;
    releaseFrames = 0;
    releasedMallet = null;
    aiRetreatFrames = 0;
    aiCornerCooldown = 0;
    disc(x, y) {
      return { x, y, px: x, py: y };
    }
    setState(next) {
      this.state = next;
      ui.network.hidden = true;
      ui.setup.hidden = next !== "setup";
      ui.message.hidden = next !== "paused" && next !== "over";
      ui.controls.hidden = next !== "playing" || this.role === "guest";
      ui.soloMenu.hidden = this.role !== "solo";
    }
    setRole(role) {
      this.role = role;
      this.updateScore();
    }
    setDifficulty(value) {
      this.difficulty = value;
    }
    setMode(value) {
      this.mode = value;
      const teamMode = value === "three";
      ui.leagueLabel.textContent = teamMode ? "TEAM LEAGUE / 02" : "NEON LEAGUE / 01";
      ui.onlineButton.disabled = teamMode;
      ui.onlineButton.textContent = teamMode ? "Direct match \xB7 1 VS 1 only" : "Play peer-to-peer";
    }
    start() {
      this.sound.ensure();
      this.score = [0, 0];
      this.updateScore();
      ui.menu.hidden = true;
      ui.resume.hidden = false;
      ui.resume.textContent = "Back to ice";
      this.resetPuck(false);
      this.setState("playing");
    }
    resetPuck(towardPlayer = Math.random() > 0.5) {
      this.puck = { x: W / 2, y: H / 2, vx: (Math.random() - 0.5) * 5, vy: (towardPlayer ? 1 : -1) * (6.5 + Math.random() * 2) };
      this.player = this.disc(W / 2, H - 185);
      this.opponent = this.disc(W / 2, 185);
      this.alliedBots = [this.disc(W / 2, H - 135), this.disc(W * 0.68, H * 0.64)];
      this.enemyBots = [this.opponent, this.disc(W * 0.32, H * 0.36), this.disc(W * 0.68, H * 0.48)];
      this.jamFrames = this.releaseFrames = this.aiRetreatFrames = this.aiCornerCooldown = 0;
      this.releasedMallet = null;
    }
    applySnapshot(snapshot) {
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
    setRemoteOpponent(x, y) {
      this.opponent.x = clamp(x, MALLET_R + 18, W - MALLET_R - 18);
      this.opponent.y = clamp(y, MALLET_R + 24, H / 2 - MALLET_R - 12);
    }
    movePlayer(event) {
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
      }
    }
    frame = (time) => {
      const dt = Math.min(1.8, (time - this.lastTime) / 16.67 || 1);
      this.lastTime = time;
      if (this.state === "playing" && this.role !== "guest") this.update(dt);
      if (this.role === "guest" && this.networkTarget) this.interpolateGuest(time);
      if (this.role === "host" && time - this.lastSnapshotAt > (reducedEffects ? 15 : 30)) {
        this.onHostSnapshot?.({ state: this.state, score: this.score, player: this.player, opponent: this.opponent, puck: this.puck });
        this.lastSnapshotAt = time;
      }
      for (const p of this.particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 0.12 * dt;
        p.life -= 0.018 * dt;
      }
      this.particles = this.particles.filter((p) => p.life > 0);
      this.flash = Math.max(0, this.flash - 0.035 * dt);
      if (!reducedEffects || time - this.lastRenderedAt >= 16) {
        this.draw();
        this.lastRenderedAt = time;
      }
      requestAnimationFrame(this.frame);
    };
    updateScore() {
      ui.playerScore.textContent = String(this.role === "guest" ? this.score[1] : this.score[0]);
      ui.aiScore.textContent = String(this.role === "guest" ? this.score[0] : this.score[1]);
    }
    burst(y, color) {
      for (let i = 0; i < (reducedEffects ? 18 : 46); i++) {
        const angle = Math.random() * Math.PI * 2, speed = 2 + Math.random() * 9;
        this.particles.push({ x: W / 2, y, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, life: 1, color });
      }
    }
    goal(playerScored) {
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
    hitMallet(mallet) {
      const dx = this.puck.x - mallet.x, dy = this.puck.y - mallet.y;
      const distance = Math.hypot(dx, dy), minimum = PUCK_R + MALLET_R;
      if (!distance || distance >= minimum) return;
      const nx = dx / distance, ny = dy / distance;
      this.puck.x = mallet.x + nx * minimum;
      this.puck.y = mallet.y + ny * minimum;
      const mvx = mallet.x - mallet.px, mvy = mallet.y - mallet.py;
      const relative = (this.puck.vx - mvx) * nx + (this.puck.vy - mvy) * ny;
      if (relative < 0) {
        this.puck.vx -= 1.85 * relative * nx;
        this.puck.vy -= 1.85 * relative * ny;
      }
      this.puck.vx += mvx * 0.55;
      this.puck.vy += mvy * 0.55;
      const speed = Math.hypot(this.puck.vx, this.puck.vy);
      if (speed > 22) {
        this.puck.vx *= 22 / speed;
        this.puck.vy *= 22 / speed;
      }
      if (this.mode === "three" && this.role === "solo" && this.alliedBots.includes(mallet)) {
        const passX = this.player.x - this.puck.x;
        const passY = this.player.y - this.puck.y;
        const passDistance = Math.hypot(passX, passY) || 1;
        this.puck.vx = this.puck.vx * 0.22 + passX / passDistance * 12.5;
        this.puck.vy = this.puck.vy * 0.22 + passY / passDistance * 12.5;
      }
      this.sound.play("mallet");
    }
    update(dt) {
      const [tracking, maxSpeed] = this.difficulty === "rookie" ? [0.055, 5.3] : this.difficulty === "legend" ? [0.13, 9.4] : [0.085, 7.2];
      const slow = Math.hypot(this.puck.vx, this.puck.vy) < 4.5;
      const side = this.puck.x < 120 || this.puck.x > W - 120;
      const targetX = this.puck.y < H * 0.64 ? this.puck.x + (side ? 0 : this.puck.vx * 8) : W / 2;
      const gap = slow ? 64 : side ? 74 : 85;
      const targetY = this.puck.y < H / 2 ? clamp(this.puck.y - gap, 95, H / 2 - 75) : 185;
      if (this.role === "solo") {
        if (this.mode === "three") this.updateTeams(dt, tracking, maxSpeed);
        else this.updateAi(dt, tracking, maxSpeed, targetX, targetY);
      }
      this.puck.x += this.puck.vx * dt;
      this.puck.y += this.puck.vy * dt;
      this.puck.vx *= Math.pow(0.9992, dt);
      this.puck.vy *= Math.pow(0.9992, dt);
      const activeMallets = this.mode === "three" && this.role === "solo" ? [this.player, ...this.alliedBots, ...this.enemyBots] : [this.player, this.opponent];
      for (const mallet of activeMallets) {
        if (this.releaseFrames > 0 && this.releasedMallet === mallet) continue;
        if (mallet === this.opponent && this.aiRetreatFrames > 0) continue;
        this.hitMallet(mallet);
      }
      this.resolveRails();
      this.resolveJam(dt);
      if (this.releaseFrames > 0) {
        this.releaseFrames = Math.max(0, this.releaseFrames - dt);
        if (!this.releaseFrames) this.releasedMallet = null;
      }
      if (this.aiRetreatFrames > 0) this.aiRetreatFrames = Math.max(0, this.aiRetreatFrames - dt);
      if (this.aiCornerCooldown > 0) this.aiCornerCooldown = Math.max(0, this.aiCornerCooldown - dt);
      if (this.puck.y < -PUCK_R * 1.5) this.goal(true);
      if (this.puck.y > H + PUCK_R * 1.5) this.goal(false);
      this.player.px = this.player.x;
      this.player.py = this.player.y;
      this.opponent.px = this.opponent.x;
      this.opponent.py = this.opponent.y;
      for (const bot of [...this.alliedBots, ...this.enemyBots]) {
        bot.px = bot.x;
        bot.py = bot.y;
      }
    }
    updateAi(dt, tracking, maxSpeed, targetX, targetY) {
      const cornerRetreat = this.aiRetreatFrames > 0;
      const jamRetreat = this.releaseFrames > 0 && this.releasedMallet === this.opponent;
      const x = cornerRetreat ? this.puck.x < W / 2 ? 190 : W - 190 : jamRetreat ? W / 2 : targetX;
      const y = cornerRetreat ? 220 : jamRetreat ? 205 : targetY;
      const factor = cornerRetreat || jamRetreat ? 0.18 : tracking;
      const speed = cornerRetreat || jamRetreat ? 12 : maxSpeed;
      this.opponent.x += clamp((x - this.opponent.x) * factor * dt, -speed * dt, speed * dt);
      this.opponent.y += clamp((y - this.opponent.y) * factor * dt, -speed * dt, speed * dt);
      this.opponent.x = clamp(this.opponent.x, MALLET_R + 18, W - MALLET_R - 18);
      this.opponent.y = clamp(this.opponent.y, MALLET_R + 24, H / 2 - MALLET_R - 12);
      const inCorner = this.puck.y < 112 && (this.puck.x < 112 || this.puck.x > W - 112);
      const touching = Math.hypot(this.puck.x - this.opponent.x, this.puck.y - this.opponent.y) < PUCK_R + MALLET_R;
      if (this.aiCornerCooldown <= 0 && inCorner && touching) {
        this.aiRetreatFrames = 10;
        this.aiCornerCooldown = 30;
        this.puck.y = Math.max(this.puck.y, PUCK_R + 24);
        this.puck.vy = Math.max(8, Math.abs(this.puck.vy));
        if (this.puck.x < W / 2) {
          this.puck.x = Math.max(this.puck.x, PUCK_R + 24);
          this.puck.vx = Math.max(9, Math.abs(this.puck.vx));
        } else {
          this.puck.x = Math.min(this.puck.x, W - PUCK_R - 24);
          this.puck.vx = -Math.max(9, Math.abs(this.puck.vx));
        }
      }
    }
    updateTeams(dt, tracking, maxSpeed) {
      const move = (bot, targetX, targetY, speedScale = 1) => {
        const speed = maxSpeed * speedScale;
        const factor = tracking * (speedScale > 1 ? 1.15 : 1);
        bot.x += clamp((targetX - bot.x) * factor * dt, -speed * dt, speed * dt);
        bot.y += clamp((targetY - bot.y) * factor * dt, -speed * dt, speed * dt);
        bot.x = clamp(bot.x, MALLET_R + 18, W - MALLET_R - 18);
      };
      const [enemyKeeper, enemyMidfielder, enemyAttacker] = this.enemyBots;
      const enemyDanger = this.puck.y < H * 0.32;
      move(enemyKeeper, clamp(this.puck.x, W / 2 - GOAL * 0.55, W / 2 + GOAL * 0.55), enemyDanger ? this.puck.y + 78 : 135, 0.9);
      move(enemyMidfielder, this.puck.y < H * 0.78 ? this.puck.x : W * 0.35, this.puck.y < H * 0.78 ? this.puck.y - 82 : H * 0.37, 0.96);
      move(enemyAttacker, this.puck.x, this.puck.y - 70, 1.12);
      const [allyKeeper, allyMidfielder] = this.alliedBots;
      const allyDanger = this.puck.y > H * 0.68;
      move(allyKeeper, clamp(this.puck.x, W / 2 - GOAL * 0.55, W / 2 + GOAL * 0.55), allyDanger ? this.puck.y + 78 : H - 135, 0.88);
      const supportX = this.puck.x * 0.72 + this.player.x * 0.28;
      const supportY = this.puck.y + Math.sign(this.player.y - this.puck.y || 1) * 82;
      move(allyMidfielder, supportX, supportY, 1.02);
      for (const bot of [...this.enemyBots, ...this.alliedBots]) {
        bot.y = clamp(bot.y, MALLET_R + 24, H - MALLET_R - 22);
      }
      this.separateTeam(this.enemyBots, MALLET_R + 24, H - MALLET_R - 22);
      this.separateTeam(this.alliedBots, MALLET_R + 24, H - MALLET_R - 22);
      for (const bot of this.alliedBots) this.pushBotAwayFromPlayer(bot);
    }
    pushBotAwayFromPlayer(bot) {
      let dx = bot.x - this.player.x, dy = bot.y - this.player.y;
      let distance = Math.hypot(dx, dy);
      const minimum = MALLET_R * 2 + 14;
      if (distance >= minimum) return;
      if (!distance) {
        dx = 1;
        dy = 0;
        distance = 1;
      }
      const push = minimum - distance;
      bot.x = clamp(bot.x + dx / distance * push, MALLET_R + 18, W - MALLET_R - 18);
      bot.y = clamp(bot.y + dy / distance * push, MALLET_R + 24, H - MALLET_R - 22);
    }
    separateTeam(team, minY, maxY) {
      const minimum = MALLET_R * 2 + 14;
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) {
          const a = team[i], b = team[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let distance = Math.hypot(dx, dy);
          if (distance >= minimum) continue;
          if (!distance) {
            dx = 1;
            dy = 0;
            distance = 1;
          }
          const push = (minimum - distance) / 2;
          const nx = dx / distance, ny = dy / distance;
          a.x -= nx * push;
          a.y -= ny * push;
          b.x += nx * push;
          b.y += ny * push;
          a.x = clamp(a.x, MALLET_R + 18, W - MALLET_R - 18);
          b.x = clamp(b.x, MALLET_R + 18, W - MALLET_R - 18);
          a.y = clamp(a.y, minY, maxY);
          b.y = clamp(b.y, minY, maxY);
        }
      }
    }
    resolveRails() {
      if (this.puck.x < PUCK_R + 18) {
        this.puck.x = PUCK_R + 18;
        this.puck.vx = Math.abs(this.puck.vx);
        this.sound.play("rail");
      }
      if (this.puck.x > W - PUCK_R - 18) {
        this.puck.x = W - PUCK_R - 18;
        this.puck.vx = -Math.abs(this.puck.vx);
        this.sound.play("rail");
      }
      const inGoal = Math.abs(this.puck.x - W / 2) < GOAL / 2;
      if (!inGoal && this.puck.y < PUCK_R + 18) {
        this.puck.y = PUCK_R + 18;
        this.puck.vy = Math.abs(this.puck.vy);
        this.sound.play("rail");
      }
      if (!inGoal && this.puck.y > H - PUCK_R - 18) {
        this.puck.y = H - PUCK_R - 18;
        this.puck.vy = -Math.abs(this.puck.vy);
        this.sound.play("rail");
      }
    }
    resolveJam(dt) {
      const left = this.puck.x < PUCK_R + 60, right = this.puck.x > W - PUCK_R - 60;
      const top = this.puck.y < PUCK_R + 60, bottom = this.puck.y > H - PUCK_R - 60;
      const mallets = this.mode === "three" && this.role === "solo" ? [this.player, ...this.alliedBots, ...this.enemyBots] : [this.player, this.opponent];
      const closest = mallets.reduce((best, mallet) => Math.hypot(this.puck.x - mallet.x, this.puck.y - mallet.y) < Math.hypot(this.puck.x - best.x, this.puck.y - best.y) ? mallet : best);
      const closestDistance = Math.hypot(this.puck.x - closest.x, this.puck.y - closest.y);
      const touching = closestDistance < PUCK_R + MALLET_R + 10;
      this.jamFrames = this.releaseFrames > 0 ? 0 : (left || right || top || bottom) && touching ? this.jamFrames + dt : 0;
      if (this.jamFrames <= 20) return;
      this.releasedMallet = closest;
      this.releaseFrames = 20;
      if (left) {
        this.puck.x = PUCK_R + 26;
        this.puck.vx = Math.max(10, Math.abs(this.puck.vx));
      }
      if (right) {
        this.puck.x = W - PUCK_R - 26;
        this.puck.vx = -Math.max(10, Math.abs(this.puck.vx));
      }
      if (top) {
        this.puck.y = PUCK_R + 26;
        this.puck.vy = Math.max(10, Math.abs(this.puck.vy));
      }
      if (bottom) {
        this.puck.y = H - PUCK_R - 26;
        this.puck.vy = -Math.max(10, Math.abs(this.puck.vy));
      }
      if ((left || right) && Math.abs(this.puck.vy) < 4) this.puck.vy = this.puck.y < H / 2 ? 5 : -5;
      if ((top || bottom) && Math.abs(this.puck.vx) < 4) this.puck.vx = this.puck.x < W / 2 ? 5 : -5;
      this.jamFrames = 0;
    }
    interpolateGuest(time) {
      const target = this.networkTarget;
      const age = Math.min(2.5, (time - this.networkTargetAt) / 16.67);
      this.puck.x += (target.puck.x + target.puck.vx * age - this.puck.x) * 0.55;
      this.puck.y += (target.puck.y + target.puck.vy * age - this.puck.y) * 0.55;
      this.puck.vx = target.puck.vx;
      this.puck.vy = target.puck.vy;
      this.player.x += (target.player.x - this.player.x) * 0.45;
      this.player.y += (target.player.y - this.player.y) * 0.45;
      if (time - this.lastGuestInputAt > 180) {
        this.opponent.x += (target.opponent.x - this.opponent.x) * 0.2;
        this.opponent.y += (target.opponent.y - this.opponent.y) * 0.2;
      }
    }
    drawMallet(mallet, color) {
      this.ctx.save();
      this.ctx.shadowBlur = reducedEffects ? 0 : 35;
      this.ctx.shadowColor = color;
      this.ctx.fillStyle = color;
      this.ctx.beginPath();
      this.ctx.arc(mallet.x, mallet.y, MALLET_R, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.shadowBlur = 0;
      this.ctx.fillStyle = "#09101e";
      this.ctx.beginPath();
      this.ctx.arc(mallet.x, mallet.y, MALLET_R - 12, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 5;
      this.ctx.stroke();
      this.ctx.restore();
    }
    renderBoard() {
      const gradient = this.boardCtx.createLinearGradient(0, 0, 0, H);
      gradient.addColorStop(0, "#11112e");
      gradient.addColorStop(0.5, "#080b20");
      gradient.addColorStop(1, "#071d27");
      this.boardCtx.fillStyle = gradient;
      this.boardCtx.fillRect(0, 0, W, H);
      this.boardCtx.strokeStyle = "rgba(255,255,255,.035)";
      this.boardCtx.lineWidth = 1;
      for (let x = 30; x < W; x += 48) {
        this.boardCtx.beginPath();
        this.boardCtx.moveTo(x, 0);
        this.boardCtx.lineTo(x, H);
        this.boardCtx.stroke();
      }
      for (let y = 30; y < H; y += 48) {
        this.boardCtx.beginPath();
        this.boardCtx.moveTo(0, y);
        this.boardCtx.lineTo(W, y);
        this.boardCtx.stroke();
      }
      this.boardCtx.lineWidth = 5;
      this.boardCtx.strokeStyle = "rgba(118,137,255,.38)";
      this.boardCtx.strokeRect(18, 18, W - 36, H - 36);
      this.boardCtx.beginPath();
      this.boardCtx.moveTo(20, H / 2);
      this.boardCtx.lineTo(W - 20, H / 2);
      this.boardCtx.strokeStyle = "rgba(255,255,255,.2)";
      this.boardCtx.stroke();
      this.boardCtx.beginPath();
      this.boardCtx.arc(W / 2, H / 2, 112, 0, Math.PI * 2);
      this.boardCtx.stroke();
      this.boardCtx.lineWidth = 12;
      this.boardCtx.strokeStyle = "#ff4d7d";
      this.boardCtx.beginPath();
      this.boardCtx.moveTo(W / 2 - GOAL / 2, 20);
      this.boardCtx.lineTo(W / 2 + GOAL / 2, 20);
      this.boardCtx.stroke();
      this.boardCtx.strokeStyle = "#58f6d0";
      this.boardCtx.beginPath();
      this.boardCtx.moveTo(W / 2 - GOAL / 2, H - 20);
      this.boardCtx.lineTo(W / 2 + GOAL / 2, H - 20);
      this.boardCtx.stroke();
    }
    draw() {
      this.ctx.drawImage(this.board, 0, 0, W, H);
      const flip = this.role === "guest";
      const view = (disc) => flip ? { ...disc, x: W - disc.x, y: H - disc.y } : disc;
      const playerColor = this.mode === "three" && this.role === "solo" ? "#5f82ff" : flip ? "#ff4d7d" : "#58f6d0";
      this.drawMallet(view(this.player), playerColor);
      if (this.mode === "three" && this.role === "solo") {
        for (const bot of this.alliedBots) this.drawMallet(view(bot), "#58f6d0");
        for (const bot of this.enemyBots) this.drawMallet(view(bot), "#ff4d7d");
      } else this.drawMallet(view(this.opponent), flip ? "#58f6d0" : "#ff4d7d");
      const x = flip ? W - this.puck.x : this.puck.x, y = flip ? H - this.puck.y : this.puck.y;
      this.ctx.save();
      this.ctx.shadowBlur = reducedEffects ? 0 : 30;
      this.ctx.shadowColor = "#eff5ff";
      this.ctx.fillStyle = "#eff5ff";
      this.ctx.beginPath();
      this.ctx.arc(x, y, PUCK_R, 0, Math.PI * 2);
      this.ctx.fill();
      this.ctx.restore();
      for (const p of this.particles) {
        this.ctx.globalAlpha = p.life;
        this.ctx.fillStyle = p.color;
        this.ctx.fillRect(flip ? W - p.x : p.x, flip ? H - p.y : p.y, 6, 6);
      }
      this.ctx.globalAlpha = 1;
      if (this.flash) {
        this.ctx.fillStyle = `rgba(255,255,255,${this.flash * 0.18})`;
        this.ctx.fillRect(0, 0, W, H);
      }
    }
  };

  // src/network.ts
  var roomApi = new URL("api/rooms", document.baseURI).toString();
  var NetworkManager = class {
    constructor(game2, sound2) {
      this.game = game2;
      sound2.broadcast = (kind) => this.sendSound(kind);
      game2.onGuestInput = (x, y) => this.sendInput(x, y);
      game2.onHostSnapshot = (snapshot) => this.sendSnapshot(snapshot);
    }
    peer = null;
    channel = null;
    roomPoll = null;
    snapshotSequence = 0;
    inputSequence = 0;
    lastReceivedSnapshot = -1;
    lastReceivedInput = -1;
    lastInputSentAt = 0;
    openMenu() {
      if (this.game.mode === "three") return;
      this.close();
      this.game.setRole("solo");
      document.querySelector("[data-role].active")?.classList.remove("active");
      ui.roomControls.hidden = true;
      ui.roomCode.value = "";
      ui.networkStatus.textContent = "Choose who creates the match";
      ui.setup.hidden = true;
      ui.network.hidden = false;
    }
    back() {
      this.close();
      this.game.setRole("solo");
      this.game.setState("setup");
    }
    async chooseRole(role) {
      if (this.game.mode === "three") throw new Error("Direct Match supports 1 VS 1 only");
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
        connection.addEventListener("datachannel", (event) => this.bindChannel(event.channel), { once: true });
        ui.applyCode.disabled = true;
        ui.applyCode.textContent = "Join room";
        ui.networkStatus.textContent = "Enter the six-character code from the host";
        ui.roomCode.focus();
      }
    }
    async joinRoom() {
      const code = ui.roomCode.value.trim().toUpperCase();
      if (!this.peer || code.length !== 6 || this.game.role !== "guest") return;
      ui.applyCode.disabled = true;
      try {
        ui.networkStatus.textContent = "Finding room\u2026";
        const response = await fetch(`${roomApi}/${encodeURIComponent(code)}`);
        if (!response.ok) throw new Error("Room not found");
        const room = await response.json();
        await this.peer.setRemoteDescription(room.offer);
        await this.peer.setLocalDescription(await this.peer.createAnswer());
        await this.waitForIce(this.peer);
        const answerResponse = await fetch(`${roomApi}/${encodeURIComponent(code)}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: this.peer.localDescription })
        });
        if (!answerResponse.ok) throw new Error("Could not join room");
        ui.networkStatus.textContent = "Room found. Connecting\u2026";
      } catch {
        ui.networkStatus.textContent = "Room not found or expired. Check the code";
        ui.applyCode.disabled = false;
      }
    }
    async copyCode() {
      try {
        await navigator.clipboard.writeText(ui.roomCode.value);
      } catch {
        ui.roomCode.select();
        document.execCommand("copy");
      }
      ui.copyCode.textContent = "Copied";
      window.setTimeout(() => ui.copyCode.textContent = "Copy room code", 1200);
    }
    close() {
      this.stopPolling();
      this.peer?.close();
      this.peer = null;
      this.channel = null;
    }
    async createRoom(connection) {
      ui.networkStatus.textContent = "Creating a six-character room\u2026";
      this.bindChannel(connection.createDataChannel("air-hockey", { ordered: false, maxRetransmits: 0 }));
      await connection.setLocalDescription(await connection.createOffer());
      await this.waitForIce(connection);
      const response = await fetch(roomApi, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offer: connection.localDescription })
      });
      if (!response.ok) throw new Error("Could not create room");
      const data = await response.json();
      ui.roomCode.value = data.code;
      ui.copyCode.disabled = false;
      ui.networkStatus.textContent = "Send this code to player 2. Waiting for connection\u2026";
      this.roomPoll = window.setInterval(async () => {
        if (!this.peer || this.peer.remoteDescription) return;
        const check = await fetch(`${roomApi}/${encodeURIComponent(data.code)}`);
        if (!check.ok) return;
        const room = await check.json();
        if (room.answer) {
          await this.peer.setRemoteDescription(room.answer);
          this.stopPolling();
          ui.networkStatus.textContent = "Player found. Connecting\u2026";
        }
      }, 700);
    }
    createPeer() {
      this.peer?.close();
      const connection = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      connection.addEventListener("connectionstatechange", () => {
        if (connection.connectionState === "failed" || connection.connectionState === "disconnected") {
          ui.networkStatus.textContent = "Connection lost \u2014 create a fresh room to reconnect";
        }
      });
      this.peer = connection;
      return connection;
    }
    bindChannel(channel) {
      this.channel = channel;
      channel.addEventListener("open", () => {
        this.snapshotSequence = this.inputSequence = 0;
        this.lastReceivedSnapshot = this.lastReceivedInput = -1;
        ui.networkStatus.textContent = "Connected \u2014 dropping the puck";
        this.game.sound.ensure();
        if (this.game.role === "host") this.game.start();
        else {
          this.game.resetPuck();
          this.game.setState("playing");
        }
      });
      channel.addEventListener("message", (event) => this.receive(JSON.parse(String(event.data))));
    }
    receive(data) {
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
    sendInput(x, y) {
      const now = performance.now();
      if (this.channel?.readyState !== "open" || now - this.lastInputSentAt < 16) return;
      this.channel.send(JSON.stringify({ type: "input", seq: this.inputSequence++, x, y }));
      this.lastInputSentAt = now;
    }
    sendSnapshot(data) {
      if (this.channel?.readyState !== "open") return;
      this.channel.send(JSON.stringify({ type: "snapshot", seq: this.snapshotSequence++, ...data }));
    }
    sendSound(kind) {
      if (this.game.role === "host" && this.channel?.readyState === "open") {
        this.channel.send(JSON.stringify({ type: "sound", kind }));
      }
    }
    stopPolling() {
      if (this.roomPoll !== null) window.clearInterval(this.roomPoll);
      this.roomPoll = null;
    }
    waitForIce(connection) {
      if (connection.iceGatheringState === "complete") return Promise.resolve();
      return new Promise((resolve) => {
        const finish = () => {
          connection.removeEventListener("icegatheringstatechange", check);
          resolve();
        };
        const check = () => {
          if (connection.iceGatheringState === "complete") finish();
        };
        connection.addEventListener("icegatheringstatechange", check);
        window.setTimeout(finish, 4500);
      });
    }
  };

  // src/main.ts
  var sound = new SoundSystem();
  var game = new Game(sound);
  var network = new NetworkManager(game, sound);
  document.querySelectorAll("[data-level]").forEach((button) => button.addEventListener("click", () => {
    document.querySelector("[data-level].active")?.classList.remove("active");
    button.classList.add("active");
    game.setDifficulty(button.dataset.level);
  }));
  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    document.querySelector("[data-mode].active")?.classList.remove("active");
    button.classList.add("active");
    game.setMode(button.dataset.mode);
  }));
  document.querySelector("#start").addEventListener("click", () => {
    game.setRole("solo");
    game.start();
  });
  document.querySelector("#online").addEventListener("click", () => network.openMenu());
  document.querySelectorAll("[data-role]").forEach((button) => button.addEventListener("click", () => {
    void network.chooseRole(button.dataset.role).catch(() => {
      ui.networkStatus.textContent = "Could not create room. Restart the local server and try again";
      ui.applyCode.disabled = false;
    });
  }));
  ui.applyCode.addEventListener("click", () => void network.joinRoom());
  ui.roomCode.addEventListener("input", () => {
    ui.roomCode.value = ui.roomCode.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    ui.applyCode.disabled = game.role !== "guest" || ui.roomCode.value.length !== 6;
  });
  ui.copyCode.addEventListener("click", () => void network.copyCode());
  document.querySelector("#network-back").addEventListener("click", () => network.back());
  document.querySelector("#restart").addEventListener("click", () => game.start());
  ui.soloMenu.addEventListener("click", () => game.setState("setup"));
  document.querySelector("#pause").addEventListener("click", () => {
    ui.label.textContent = "TIME OUT";
    ui.title.textContent = "Paused";
    ui.resume.textContent = "Back to ice";
    ui.menu.hidden = true;
    game.setState("paused");
  });
  ui.resume.addEventListener("click", () => game.state === "over" ? game.start() : game.setState("playing"));
  ui.menu.addEventListener("click", () => game.setState("setup"));
  ui.canvas.addEventListener("pointermove", (event) => game.movePlayer(event));
  ui.canvas.addEventListener("pointerdown", (event) => {
    ui.canvas.setPointerCapture(event.pointerId);
    game.movePlayer(event);
  });
  window.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || game.state !== "playing" && game.state !== "paused") return;
    event.preventDefault();
    game.state === "playing" ? document.querySelector("#pause").click() : game.setState("playing");
  });
  requestAnimationFrame(game.frame);
})();
//# sourceMappingURL=air-hockey.js.map
