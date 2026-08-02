const get = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

export const ui = {
  canvas: get<HTMLCanvasElement>("#game"),
  leagueLabel: get<HTMLElement>("#league-label"),
  onlineButton: get<HTMLButtonElement>("#online"),
  setup: get<HTMLElement>("#setup"),
  message: get<HTMLElement>("#message"),
  controls: get<HTMLElement>("#controls"),
  playerScore: get<HTMLElement>("#player-score"),
  aiScore: get<HTMLElement>("#ai-score"),
  title: get<HTMLElement>("#message-title"),
  label: get<HTMLElement>("#message-label"),
  resume: get<HTMLButtonElement>("#resume"),
  menu: get<HTMLButtonElement>("#menu"),
  network: get<HTMLElement>("#network"),
  networkStatus: get<HTMLElement>("#network-status"),
  roomCode: get<HTMLInputElement>("#room-code"),
  applyCode: get<HTMLButtonElement>("#apply-code"),
  copyCode: get<HTMLButtonElement>("#copy-code"),
  roomControls: get<HTMLElement>("#room-controls"),
  soloMenu: get<HTMLButtonElement>("#solo-menu"),
};
