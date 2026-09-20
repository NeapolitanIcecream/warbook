# Third-party components

This repository's code uses the existing Apache-2.0 license. Upstream components retain their own terms.

- `@chronodivide/game-api@0.79.0`: official Chrono Divide SDK, installed from npm; package declares `UNLICENSED`. Its exact source and gameplay resource hashes are recorded in the project.
- Chrono Divide browser client: downloaded from the official site into ignored local cache. Client 0.83.3 matches the engine version embedded in the pinned SDK. The local server supplies the SDK's own `ra2cd.mix` so the gameplay resource hash matches. No client bundle or game resource is committed or included in this repository's source distribution.
- Original Red Alert 2 MIX files: supplied locally by the user. These files are not redistributed.
- Supalosa's npm bot and the official client bot are evaluation opponents. Their code is not copied into the repository. They retain their upstream terms and are tested with their native information access.
- Hono, esbuild, tsx, Three.js, TypeScript, Playwright and other npm dependencies retain their respective licenses. Three.js 0.94.0 is deliberately pinned to the version used by the reference engine.
- Local planning uses [ngraph.graph](https://github.com/anvaka/ngraph.graph) 20.1.2 (BSD-3-Clause), [ngraph.path](https://github.com/anvaka/ngraph.path) 1.6.1 (MIT), and ngraph.events 1.4.0 (MIT). Their license texts are retained in `third-party/`; these libraries are bundled into frozen bot artifacts. Planning never calls the SDK's mutable path cache.
- Experimental model inference uses TensorFlow.js core and CPU backend 4.22.0 (Apache-2.0), with seedrandom 3.0.5 (MIT) for policy sampling. Frozen Node bundles include encoding 0.1.13 (MIT), required by an optional transitive text codec. Training uses an isolated CPU PyTorch 2.9.1 environment; no installed runtime or trained weights are committed.

The source URL and SHA-256 of each downloaded client resource are stored in local cache metadata. Large replays, downloaded software, game files, browser profiles and run records stay outside Git.
