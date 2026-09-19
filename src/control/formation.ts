import { distance2, type Point, type Unit } from "../model.js";

export function formedUnits(units: readonly Unit[], near: Point): Unit[] {
  return (
    units
      .map((anchor) => ({
        anchor,
        members: units.filter((u) => distance2(u, anchor) <= 6 ** 2),
      }))
      .sort(
        (a, b) =>
          b.members.length - a.members.length ||
          distance2(a.anchor, near) - distance2(b.anchor, near),
      )[0]?.members ?? []
  );
}

/** Native movement needs a real occupied ground tile, not an average that may fall in a cliff. */
export function rendezvous(units: readonly Unit[]): Point {
  const center = {
    x: units.reduce((s, u) => s + u.x, 0) / units.length,
    y: units.reduce((s, u) => s + u.y, 0) / units.length,
  };
  const available = units.filter((u) => !u.onBridge);
  const unit = [...(available.length ? available : units)].sort(
    (a, b) => distance2(a, center) - distance2(b, center),
  )[0];
  return {
    x: unit.x,
    y: unit.y,
    ...(unit.onBridge === undefined ? {} : { onBridge: unit.onBridge }),
  };
}
