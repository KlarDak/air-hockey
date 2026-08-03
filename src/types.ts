export type GameState = "setup" | "playing" | "paused" | "over";
export type Difficulty = "rookie" | "pro" | "legend";
export type SoundKind = "rail" | "mallet" | "goal";
export type NetworkRole = "solo" | "host" | "guest";
export type GameMode = "duel" | "three";
export type Disc = { x: number; y: number; px: number; py: number };
export type Puck = { x: number; y: number; vx: number; vy: number };
export type Particle = { x: number; y: number; vx: number; vy: number; life: number; color: string };
export type Snapshot = { type: "snapshot"; seq: number; state: GameState; score: [number, number]; player: Disc; opponent: Disc; puck: Puck };
export type PeerMessage =
  | Snapshot
  | { type: "input"; seq: number; x: number; y: number; vx: number; vy: number; latency: number }
  | { type: "hit"; seq: number; puck: Puck }
  | { type: "sound"; kind: SoundKind };
