import { ApiEventType, type ApiEvent } from "@chronodivide/game-api";

/** Only previously observed own IDs enter this table; no enemy events allocate refs. */
export class OwnLifecycle {
  private readonly observedOwn = new Map<number, string>();
  private readonly departed = new Set<string>();

  seenOwn(nativeId: number, localRef: string) {
    this.observedOwn.set(nativeId, localRef);
  }

  onEvent(event: ApiEvent, ownName: string) {
    const ref = this.observedOwn.get(event.target);
    if (!ref) return;
    if (
      event.type === ApiEventType.ObjectDestroy ||
      (event.type === ApiEventType.ObjectOwnerChange &&
        event.prevOwnerName === ownName &&
        event.newOwnerName !== ownName)
    ) {
      this.departed.add(ref);
      this.observedOwn.delete(event.target);
    }
  }

  takeDepartures(): readonly string[] {
    const result = [...this.departed];
    this.departed.clear();
    return result;
  }
}
