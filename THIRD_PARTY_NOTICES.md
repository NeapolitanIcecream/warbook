# Third-party components

This repository's code uses the existing Apache-2.0 license. Upstream components retain their own terms.

- `@chronodivide/game-api@0.79.0`: official Chrono Divide SDK, installed from npm; package declares `UNLICENSED`. Its exact source and gameplay resource hashes are recorded in the project.
- Chrono Divide browser client: downloaded from the official site into ignored local cache. Client 0.83.3 matches the engine version embedded in the pinned SDK. The local server supplies the SDK's own `ra2cd.mix` so the gameplay resource hash matches. No client bundle or game resource is committed or included in this repository's source distribution.
- Original Red Alert 2 MIX files: supplied locally by the user. These files are not redistributed.
- Supalosa's npm bot and the official client bot are evaluation opponents. Their code is not copied into the repository. They retain their upstream terms and are tested with their native information access.
- Hono, esbuild, tsx, Three.js, TypeScript, Playwright and other npm dependencies retain their respective licenses. Three.js 0.94.0 is deliberately pinned to the version used by the reference engine.

The source URL and SHA-256 of each downloaded client resource are stored in local cache metadata. Large replays, downloaded software, game files, browser profiles and run records stay outside Git.
