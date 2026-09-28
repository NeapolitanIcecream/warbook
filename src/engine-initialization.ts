import type { Replay } from "@chronodivide/game-api";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Diagnostic engine truth. This information is never passed to an actor.
export function offlineInitialization(
  replay: Pick<
    Replay,
    "gameId" | "gameTimestamp" | "engineVersion" | "modHash"
  > & {
    gameOpts: Pick<Replay["gameOpts"], "mapDigest">;
  },
  rulesHash: string,
) {
  if (replay.gameId !== "0" || !Number.isSafeInteger(replay.gameTimestamp))
    throw new Error(
      "Expected the pinned engine's offline initialization header",
    );
  return {
    schema: "offline-engine-prng-input-v1" as const,
    gameId: replay.gameId,
    gameTimestamp: replay.gameTimestamp,
    // Same input source does not imply the same map, actor, or trajectory.
    randomSourceKey: `${replay.gameId}:${replay.gameTimestamp}`,
    engineVersion: replay.engineVersion,
    modHash: replay.modHash,
    mapDigest: replay.gameOpts.mapDigest,
    rulesHash,
  };
}

export const INITIALIZATION_GATE_WAIT_MS = 300_000;

/** Serialize only initialization, with a fresh wall-clock second for each game. */
export async function createWithInitializationGate<T>(
  create: () => Promise<T>,
  directory?: string,
) {
  const requestedAtMs = Date.now();
  let lock: number | undefined;
  const gateDirectory = directory ? resolve(directory) : undefined;
  const lockPath = gateDirectory && resolve(gateDirectory, "owner.json");
  const statePath = gateDirectory && resolve(gateDirectory, "state.json");
  const ticket =
    gateDirectory &&
    `pending-${String(requestedAtMs).padStart(16, "0")}-${process.pid}-${randomUUID()}.json`;
  const ticketPath = gateDirectory && resolve(gateDirectory, ticket!);
  const checkDeadline = () => {
    if (Date.now() - requestedAtMs >= INITIALIZATION_GATE_WAIT_MS)
      throw new Error(
        `Initialization gate wait exceeded 300 seconds: ${gateDirectory}`,
      );
  };
  const checkOwner = (path: string, kind: string) => {
    // A just-created file may not yet contain JSON; leave it in place and retry.
    // Fail closed on a dead process, without racing to remove its lock/ticket.
    let owner: { pid?: number } = {};
    try {
      owner = JSON.parse(readFileSync(path, "utf8"));
    } catch {}
    if (Number.isInteger(owner.pid)) {
      try {
        process.kill(owner.pid!, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH")
          throw new Error(
            `Stale initialization gate ${kind} ${owner.pid}: ${path}; clear it after stopping this gate's users`,
          );
        throw error;
      }
    }
  };
  try {
    if (gateDirectory) {
      mkdirSync(gateDirectory, { recursive: true });
      writeFileSync(
        ticketPath!,
        JSON.stringify({ pid: process.pid, requestedAtMs }),
        { flag: "wx" },
      );
      while (lock === undefined) {
        checkDeadline();
        // New arrivals cannot continually overtake a waiter. Requests in the
        // same millisecond have a stable arbitrary order; wx remains the mutex.
        const first = readdirSync(gateDirectory)
          .filter((n) => n.startsWith("pending-") && n.endsWith(".json"))
          .sort()[0];
        if (first !== ticket) {
          if (first) checkOwner(resolve(gateDirectory, first), "waiter");
          await delay(25);
          continue;
        }
        try {
          lock = openSync(lockPath!, "wx");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          checkOwner(lockPath!, "owner");
          await delay(25);
        }
      }
      writeFileSync(
        lock,
        JSON.stringify({ pid: process.pid, requestedAtMs, ticket }),
      );
    }
    if (statePath) {
      let nextAllowedAtMs = 0;
      try {
        nextAllowedAtMs = JSON.parse(
          readFileSync(statePath, "utf8"),
        ).nextAllowedAtMs;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!Number.isSafeInteger(nextAllowedAtMs) || nextAllowedAtMs < 0)
        throw new Error(`Invalid initialization gate state: ${statePath}`);
      while (Date.now() < nextAllowedAtMs) {
        checkDeadline();
        await delay(Math.min(1000, nextAllowedAtMs - Date.now()));
      }
    }
    const createStartedAtMs = Date.now();
    const value = await create();
    const createFinishedAtMs = Date.now();
    return {
      value,
      timing: {
        requestedAtMs,
        createStartedAtMs,
        createFinishedAtMs,
        gateWaitMillis: createStartedAtMs - requestedAtMs,
        gateDirectory,
        gateTicket: ticket,
      },
    };
  } finally {
    try {
      if (lock !== undefined) {
        try {
          // The SDK samples its timestamp inside createGame. Waiting beyond the
          // completion second also covers variable map-loading time before that.
          writeFileSync(
            statePath!,
            JSON.stringify({
              nextAllowedAtMs: (Math.floor(Date.now() / 1000) + 1) * 1000 + 20,
            }),
          );
        } finally {
          closeSync(lock);
          unlinkSync(lockPath!);
        }
      }
    } finally {
      if (ticketPath) {
        try {
          unlinkSync(ticketPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
  }
}
