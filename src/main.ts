import { SoundSystem } from "./audio";
import { Game } from "./game";
import { NetworkManager } from "./network";
import { ui } from "./ui";
import type { Difficulty } from "./types";

const sound = new SoundSystem();
const game = new Game(sound);
const network = new NetworkManager(game, sound);

document.querySelectorAll<HTMLButtonElement>("[data-level]").forEach(button => button.addEventListener("click", () => {
  document.querySelector("[data-level].active")?.classList.remove("active");
  button.classList.add("active");
  game.setDifficulty(button.dataset.level as Difficulty);
}));

document.querySelector("#start")!.addEventListener("click", () => { game.setRole("solo"); game.start(); });
document.querySelector("#online")!.addEventListener("click", () => network.openMenu());
document.querySelectorAll<HTMLButtonElement>("[data-role]").forEach(button => button.addEventListener("click", () => {
  void network.chooseRole(button.dataset.role as "host" | "guest").catch(() => {
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
document.querySelector("#network-back")!.addEventListener("click", () => network.back());
document.querySelector("#restart")!.addEventListener("click", () => game.start());
ui.soloMenu.addEventListener("click", () => game.setState("setup"));
document.querySelector("#pause")!.addEventListener("click", () => {
  ui.label.textContent = "TIME OUT"; ui.title.textContent = "Paused"; ui.resume.textContent = "Back to ice";
  ui.menu.hidden = true; game.setState("paused");
});
ui.resume.addEventListener("click", () => game.state === "over" ? game.start() : game.setState("playing"));
ui.menu.addEventListener("click", () => game.setState("setup"));
ui.canvas.addEventListener("pointermove", event => game.movePlayer(event));
ui.canvas.addEventListener("pointerdown", event => { ui.canvas.setPointerCapture(event.pointerId); game.movePlayer(event); });
window.addEventListener("keydown", event => {
  if (event.code !== "Space" || (game.state !== "playing" && game.state !== "paused")) return;
  event.preventDefault();
  game.state === "playing" ? document.querySelector<HTMLButtonElement>("#pause")!.click() : game.setState("playing");
});

requestAnimationFrame(game.frame);
