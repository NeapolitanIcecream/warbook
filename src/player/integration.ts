import { WarbookBot, OBSERVATION_PROTOCOL } from "../bridge.js";
import { POLICY_VERSION, type PolicyMode } from "../policy.js";
declare const __WARBOOK_POLICY__: PolicyMode;

declare global {
  var SystemJS: { import(name: string): Promise<any> };
  var WarbookSession: {
    version: string;
    protocol: string;
    sessionId: string;
    games: number;
    bots: WarbookBot[];
    error?: string;
    lastResult?: unknown;
  };
}

export async function install(): Promise<void> {
  const [
    { BotFactory },
    { GameFactory },
    { SkirmishScreen },
    { StorageKey },
    { GameScreen },
    { Engine },
  ] = await Promise.all([
    SystemJS.import("game/bot/BotFactory"),
    SystemJS.import("game/GameFactory"),
    SystemJS.import("gui/screen/mainMenu/lobby/SkirmishScreen"),
    SystemJS.import("LocalPrefs"),
    SystemJS.import("gui/screen/game/GameScreen"),
    SystemJS.import("engine/Engine"),
  ]);
  const session = (globalThis.WarbookSession = {
    version: POLICY_VERSION,
    protocol: OBSERVATION_PROTOCOL,
    sessionId: crypto.randomUUID(),
    games: 0,
    bots: [],
  } as typeof WarbookSession);
  const originalOptions = SkirmishScreen.prototype.initOptions;
  SkirmishScreen.prototype.initOptions = async function () {
    const first = !localStorage.getItem("warbook.defaults.v2");
    if (first) {
      this.localPrefs.setItem(StorageKey.LastMap, "mp03t4.map");
      this.localPrefs.setItem(StorageKey.LastMode, "1");
    }
    await originalOptions.call(this);
    if (first) {
      const country = this.getAvailablePlayerCountries().indexOf("Americans");
      this.gameOpts.humanPlayers[0].countryId = country;
      this.localPrefs.setItem(StorageKey.LastPlayerCountry, String(country));
      for (const ai of this.gameOpts.aiPlayers) if (ai) ai.countryId = country;
      this.saveBotSettings();
      this.applyGameOption((options: any) =>
        Object.assign(options, {
          credits: 10000,
          unitCount: 0,
          gameSpeed: 4,
          shortGame: true,
          cratesAppear: false,
          superWeapons: false,
          buildOffAlly: false,
        }),
      );
      localStorage.setItem("warbook.defaults.v2", "1");
    }
  };
  BotFactory.prototype.create = function (player: any) {
    const bot = new WarbookBot(
      player.name,
      player.country.name,
      __WARBOOK_POLICY__,
    );
    bot.autoTick = true;
    session.bots.push(bot);
    // Evidence is written locally. These records never feed the policy.
    let events: unknown[] = [];
    let lastFlush = 0;
    bot.trace = (event) => {
      events.push(event);
      if (event.tick - lastFlush >= 150 || events.length > 30) {
        void fetch("/warbook/telemetry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: session.sessionId,
            game: session.games,
            events,
          }),
        });
        events = [];
        lastFlush = event.tick;
      }
    };
    bot.onGameStart = (api) => {
      const gameNumber = session.games;
      const rules = new TextEncoder().encode(api.getRulesIni().toString());
      void crypto.subtle.digest("SHA-256", rules).then((hash) =>
        fetch("/warbook/telemetry", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId: session.sessionId,
            game: gameNumber,
            events: [
              {
                kind: "rules",
                actor: bot.name,
                sha256: [...new Uint8Array(hash)]
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join(""),
              },
            ],
          }),
        }),
      );
    };
    return bot;
  };
  const originalCreate = GameFactory.create;
  let currentGame: any;
  let roster: any[] = [];
  const recordStop = (kind: string) => {
    if (!currentGame) return;
    const result = {
      game: session.games,
      tick: currentGame.currentTick,
      status: currentGame.status,
      players: roster.map((p) => ({
        name: p.name,
        defeated: p.defeated,
        resigned: p.resigned,
        credits: p.credits,
      })),
    };
    session.lastResult = result;
    void fetch("/warbook/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        game: session.games,
        events: [{ kind, ...result }],
      }),
    });
  };
  const originalLeave = GameScreen.prototype.onLeave;
  GameScreen.prototype.onLeave = async function (...args: unknown[]) {
    recordStop("player_exit");
    const result = await originalLeave.apply(this, args);
    currentGame = undefined;
    session.bots = [];
    return result;
  };
  GameFactory.create = function (...args: unknown[]) {
    session.bots = [];
    session.games++;
    const game = originalCreate.apply(this, args);
    currentGame = game;
    roster = game.getCombatants();
    void fetch("/warbook/telemetry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        game: session.games,
        events: [
          {
            kind: "game_created",
            engineVersion: Engine.getVersion(),
            modHash: Engine.getModHash(),
            options: game.gameOpts,
            roster: roster.map((p) => ({
              name: p.name,
              country: p.country.name,
              startLocation: p.startLocation,
            })),
          },
        ],
      }),
    });
    game.onEnd.subscribe(() => recordStop("game_end"));
    return game;
  };
  const bar = document.createElement("div");
  bar.id = "warbook-status";
  bar.style.cssText =
    "position:fixed;z-index:10000;left:12px;bottom:8px;background:#111c25e8;color:#ccd8de;font:12px system-ui;padding:6px 10px;border:1px solid #425665;border-radius:5px;pointer-events:none";
  bar.textContent = `Warbook 本地 AI · ${POLICY_VERSION} · 点击「本地对战」开局`;
  document.body.append(bar);
  setInterval(() => {
    const bot = session.bots[0];
    bar.textContent = bot?.observation
      ? `Warbook 本地 AI · ${POLICY_VERSION} · 对战中`
      : `Warbook 本地 AI · ${POLICY_VERSION} · 点击「本地对战」开局`;
  }, 1000);
  window.addEventListener("error", (event) => {
    session.error = event.message;
  });
}
