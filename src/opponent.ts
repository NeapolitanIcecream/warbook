import { SupalosaBot } from "@supalosa/chronodivide-bot/dist/bot/bot.js";
import { Countries } from "@supalosa/chronodivide-bot/dist/bot/logic/common/utils.js";
import type { GameApi } from "@chronodivide/game-api";

/** Native opponent information/actions; an external anchor, not our observation protocol. */
export class SupalosaOpponent extends SupalosaBot {
  readonly mode = "supalosa-native-0.6.8-beta.3-165b77a";
  constructor(name: string) {
    super(name, Countries.USA, [], false);
  }
  override onGameTick(_game: GameApi): void {}
  step(game: GameApi): void {
    super.onGameTick(game);
  }
}
