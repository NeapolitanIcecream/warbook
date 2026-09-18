import { loadReplayClipControls } from "./replay-clips.js";

/** Use the pinned client's own replay speed/pause mechanism; recorded actions are untouched. */
export async function installReplayControls(): Promise<void> {
  const addClipControls = await loadReplayClipControls();
  const { ReplayScreen } = await SystemJS.import(
    "gui/screen/replay/ReplayScreen",
  );
  const original = ReplayScreen.prototype.onGameStart;
  ReplayScreen.prototype.onGameStart = function (...args: unknown[]) {
    original.apply(this, args);
    const screen = this;
    const panel = document.createElement("form");
    panel.setAttribute("aria-label", "回放定位");
    panel.style.cssText =
      "position:fixed;right:180px;bottom:40px;z-index:10000;padding:8px 10px;border-radius:6px;background:#0b1829e8;color:white;font:13px system-ui;display:flex;gap:8px;align-items:center";
    const input = document.createElement("input");
    input.setAttribute("aria-label", "回放时刻");
    input.placeholder = "分:秒";
    input.value = screen.warbookReviewTime ?? "7:30";
    input.style.cssText = "width:64px;font:inherit";
    const button = document.createElement("button");
    button.textContent = "跳到并暂停";
    const status = document.createElement("span");
    status.setAttribute("role", "status");
    panel.append(input, button, status);
    panel.addEventListener("keydown", (event) => event.stopPropagation());
    panel.addEventListener("keyup", (event) => event.stopPropagation());
    document.body.append(panel);
    const run = () => {
      const game = screen.game;
      if (!game) return;
      game.desiredSpeed.value = screen.baseSpeed * 8;
      if (game.speed.value === Number.EPSILON)
        screen.gameTurnMgr.doGameTurn(performance.now());
    };
    panel.onsubmit = async (event) => {
      event.preventDefault();
      const match = /^(\d+):([0-5]\d)$/.exec(input.value.trim());
      if (!match) {
        status.textContent = "请输入分:秒";
        return;
      }
      const tick = (Number(match[1]) * 60 + Number(match[2])) * 15;
      input.blur();
      button.blur();
      screen.warbookReviewTime = input.value.trim();
      screen.warbookReviewTick = tick;
      if (tick < screen.game.currentTick) {
        const params = screen.params;
        await screen.onLeave();
        await screen.onEnter(params);
      } else run();
    };
    const timer = setInterval(() => {
      if (!screen.game) return;
      const tick = screen.game.currentTick;
      if (
        screen.warbookReviewTick !== undefined &&
        tick >= screen.warbookReviewTick
      ) {
        screen.game.desiredSpeed.value = Number.EPSILON;
        screen.warbookReviewTick = undefined;
      }
      status.textContent = `${Math.floor(tick / 900)}:${String(Math.floor(tick / 15) % 60).padStart(2, "0")}${screen.game.desiredSpeed.value === Number.EPSILON ? " 已暂停" : ""}`;
    }, 16);
    screen.disposables.add(() => {
      clearInterval(timer);
      panel.remove();
    });
    if (screen.warbookReviewTick !== undefined) run();
    addClipControls(screen);
  };
}
