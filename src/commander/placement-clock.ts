/** Complete-strategy decisions must receive Ready footprints on their own clock. */
export function shouldScanPlacement(
  fullStrategy: boolean,
  fort: boolean,
  tick: number,
  lastFortTick: number,
): boolean {
  return fullStrategy ? tick % 75 === 0 : !fort || tick - lastFortTick >= 30;
}
