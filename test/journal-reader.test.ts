import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { readJournal } from "../src/journal-reader.js";

test("journal readers preserve bytes in plaintext, legacy gzip and zstd", async () => {
  const directory = mkdtempSync(join(tmpdir(), "warbook-journal-"));
  const bytes = Buffer.from('{"tick":75,"action":"保持"}\n'.repeat(200));
  try {
    for (const [suffix, data] of [
      ["", bytes],
      [".gz", gzipSync(bytes)],
      [".zst", zstdCompressSync(bytes)],
    ] as const) {
      const path = join(directory, "journal" + (suffix || "-plain"));
      writeFileSync(path + suffix, data);
      const parts: Buffer[] = [];
      for await (const part of readJournal(path)) parts.push(Buffer.from(part));
      assert.deepEqual(Buffer.concat(parts), bytes);
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});
