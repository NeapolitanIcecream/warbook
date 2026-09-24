import { createReadStream, existsSync } from "node:fs";
import { createGunzip, createZstdDecompress } from "node:zlib";

/** The journal bytes are identical across plaintext and the two archive codecs. */
export function journalPath(path: string) {
  return existsSync(path)
    ? path
    : path + (existsSync(path + ".zst") ? ".zst" : ".gz");
}

export function readJournal(path: string) {
  const stored = journalPath(path);
  if (stored === path) return createReadStream(path);
  const zstd = stored.endsWith(".zst");
  const source = createReadStream(stored);
  const decoder = zstd ? createZstdDecompress() : createGunzip();
  source.on("error", (error) => decoder.destroy(error));
  return source.pipe(decoder);
}
