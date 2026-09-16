import { Hono, type Context } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  CLIENT_BUILDS,
  LEGACY_CLIENT,
  PINNED_CLIENT,
  SDK_RESOURCE_SHA,
  type ClientBuild,
} from "./client.js";

const telemetryDir = resolve("runs/player");
mkdirSync(telemetryDir, { recursive: true });
const port = Number(process.env.PORT ?? 8642);
const localOrigin = `http://127.0.0.1:${port}`;
const releasePath = process.env.PLAYER_RELEASE
  ? `dist/player/${process.env.PLAYER_RELEASE}/release.json`
  : "dist/player/current.json";
const release = JSON.parse(readFileSync(releasePath, "utf8"));
const client = CLIENT_BUILDS.get(
  release.clientVersion ?? LEGACY_CLIENT.version,
);
if (!client) throw new Error("Unsupported client version");
const CLIENT_VERSION = client.version;
if (!/^[a-f0-9]{64}$/.test(release.sha256))
  throw new Error("Invalid player release");
const botPath = `dist/player/${release.sha256}/bot.js`;
if (
  createHash("sha256").update(readFileSync(botPath)).digest("hex") !==
  release.sha256
)
  throw new Error("Player bundle hash mismatch");
const challengerRelease = process.env.PLAYER_CHALLENGER
  ? JSON.parse(
      readFileSync(
        `dist/player/${process.env.PLAYER_CHALLENGER}/release.json`,
        "utf8",
      ),
    )
  : undefined;
const challengerBotPath = challengerRelease
  ? `dist/player/${challengerRelease.sha256}/bot.js`
  : undefined;
if (
  challengerRelease &&
  (!/^[a-f0-9]{64}$/.test(challengerRelease.sha256) ||
    challengerRelease.clientVersion !== CLIENT_VERSION ||
    createHash("sha256")
      .update(readFileSync(challengerBotPath!))
      .digest("hex") !== challengerRelease.sha256)
)
  throw new Error("Challenger must be a verified bundle for the same client");
const pending = new Map<string, Promise<{ body: Buffer; type: string }>>();
// Keep one selected, completed match available without exposing local file paths.
const watchResult = process.env.WATCH_MATCH
  ? JSON.parse(readFileSync(process.env.WATCH_MATCH, "utf8"))
  : undefined;
const watchReplay = watchResult
  ? readFileSync(watchResult.replay.file)
  : undefined;
if (
  watchResult &&
  (!watchResult.cleanCompletionVerified ||
    watchResult.stopState?.status !== "Ended" ||
    watchResult.stopState?.turnManagerError !== false ||
    CLIENT_VERSION !== PINNED_CLIENT.version ||
    watchResult.replay.engineVersion !== "0.83" ||
    createHash("sha256").update(watchReplay!).digest("hex") !==
      watchResult.replay.sha256)
)
  throw new Error(
    "WATCH_MATCH must reference a verified, compatible full game",
  );

async function getClientAsset(
  path: string,
  sourceUrl?: string,
  build: ClientBuild = client!,
): Promise<{ body: Buffer; type: string }> {
  if (
    build.version === PINNED_CLIENT.version &&
    /^\/res\/ra2cd\.mix(?:\?|$)/.test(path)
  ) {
    const body = readFileSync(
      "node_modules/@chronodivide/game-api/dist/res/ra2cd.mix",
    );
    if (createHash("sha256").update(body).digest("hex") !== SDK_RESOURCE_SHA)
      throw new Error("Pinned SDK resource hash mismatch");
    return { body, type: "application/octet-stream" };
  }
  const cacheDir = resolve(
    build.version === LEGACY_CLIENT.version
      ? "work/client-cache"
      : `work/client-cache/${build.version}`,
  );
  mkdirSync(cacheDir, { recursive: true });
  const pendingKey = build.version + ":" + path;
  const key = createHash("sha256").update(path).digest("hex");
  const file = `${cacheDir}/${key}`;
  if (existsSync(file) && existsSync(file + ".json"))
    return {
      body: readFileSync(file),
      type: JSON.parse(readFileSync(file + ".json", "utf8")).type,
    };
  if (process.env.OFFLINE === "1")
    throw new Error(`Client asset is not cached: ${path}`);
  if (pending.has(pendingKey)) return pending.get(pendingKey)!;
  const task = (async () => {
    const response = await fetch(sourceUrl ?? build.baseUrl + path, {
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok)
      throw new Error(`Official asset returned ${response.status}: ${path}`);
    const body = Buffer.from(await response.arrayBuffer());
    const hash = createHash("sha256").update(body).digest("hex");
    if (path.startsWith("/dist/ra2web.min.js") && hash !== build.bundleSha256)
      throw new Error(
        "Official engine changed; update integration after verification.",
      );
    const type =
      response.headers.get("content-type") ?? "application/octet-stream";
    writeFileSync(file, body);
    writeFileSync(
      file + ".json",
      JSON.stringify({
        path,
        sourceUrl: sourceUrl ?? build.baseUrl + path,
        type,
        sha256: hash,
        bytes: body.length,
      }),
    );
    console.log("Cached", path, body.length);
    return { body, type };
  })();
  pending.set(pendingKey, task);
  try {
    return await task;
  } finally {
    pending.delete(pendingKey);
  }
}

// Use the original local MIX files. The archive is a disposable import artifact.
const archive = resolve("assets/ra2-local.zip");
if (!existsSync(archive)) {
  const mixDir = resolve(process.env.MIX_DIR ?? "assets/ra2");
  execFileSync(
    "zip",
    [
      "-0",
      "-j",
      archive,
      ...["ra2.mix", "language.mix", "multi.mix"].map(
        (name) => `${mixDir}/${name}`,
      ),
    ],
    { stdio: "ignore" },
  );
}
const app = new Hono();
app.use("*", async (c, next) => {
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Embedder-Policy", "require-corp");
  await next();
});
app.onError((error, c) => {
  console.error(error.message);
  return c.text(error.message, 500);
});
app.get("/favicon.ico", (c) => c.body(null, 204));
app.get("/warbook/gpu/:file", async (c) => {
  const file = c.req.param("file");
  if (!/^[a-z0-9-]+\.json$/.test(file)) return c.text("Unknown benchmark", 404);
  const asset = await getClientAsset(
    "/gpu/" + file,
    "https://unpkg.com/detect-gpu@5.0.42/dist/benchmarks/" + file,
  );
  return c.body(new Uint8Array(asset.body), 200, {
    "Content-Type": asset.type,
  });
});
app.get("/", (c) =>
  c.html(
    `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Warbook · 本地对战</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1119;color:#e5ebf0;font:17px/1.65 system-ui}main{max-width:680px;padding:48px}small{color:#8cabb8;letter-spacing:3px}h1{font-size:52px;margin:12px 0}p{color:#adbac7}.start{display:inline-block;padding:14px 28px;background:#c9aa65;color:#111820;text-decoration:none;font-weight:700;border-radius:5px;margin:20px 12px 20px 0}.watch{background:transparent;color:#c9aa65;border:1px solid #c9aa65}li{margin:6px 0}footer{margin-top:40px;font-size:13px;color:#758793}</style><main><small>WARBOOK / LOCAL PLAY</small><h1>指挥你的下一场战役。</h1><p>在红色警戒 2 的完整战场上，与 Warbook AI 对战。</p><a class="start" href="/game/">开始本地对战 →</a>${challengerRelease ? (challengerRelease.mode === "bastion" ? '<a class="start watch" href="/challenge/">挑战阵地反击 AI →</a><p>实验对手：部署步兵、建立工事，组织坦克反击。</p>' : '<a class="start watch" href="/challenge/">挑战集结反击 AI →</a><p>实验对手：先守住开局，集中坦克后反击。</p>') : ""}${watchReplay ? '<a class="start watch" href="/watch">观看 AI 对局回放 →</a>' : ""}<ol><li>选择「本地对战」，点击「开始游戏」。</li><li>选择美国，展开基地车，建设基地并作战。</li><li>按 Esc 退出；回到菜单即可再次开局。</li></ol><p>首次打开会自动导入本机游戏资源，稍候即可。</p><footer>研发试玩版 · 客户端 ${CLIENT_VERSION} · AI 使用已探索区域的 API 观察。<br>支持基本建设、采矿、补兵和地面战斗；仍在持续改进。</footer></main></html>`,
  ),
);
app.get("/watch", (c) =>
  watchReplay
    ? c.redirect(
        `/game/#/replay/${encodeURIComponent(localOrigin + "/warbook/watch.rpl")}`,
      )
    : c.html('<p>还没有可观看的对局。</p><a href="/">返回本地入口</a>', 404),
);
app.get("/warbook/watch.rpl", (c) =>
  watchReplay
    ? c.body(new Uint8Array(watchReplay), 200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-store",
      })
    : c.notFound(),
);
app.get("/warbook/health", (c) =>
  c.json({
    ok: true,
    clientVersion: CLIENT_VERSION,
    offline: process.env.OFFLINE === "1",
    watchAvailable: Boolean(watchReplay),
    release,
    challengerRelease,
  }),
);
app.get("/warbook/bot.js", serveStatic({ path: botPath }));
if (challengerBotPath)
  app.get("/warbook/challenger.js", serveStatic({ path: challengerBotPath }));
app.get(
  "/warbook/ra2-local.zip",
  serveStatic({ path: "assets/ra2-local.zip" }),
);
const receiveTelemetry =
  (selectedRelease: typeof release) => async (c: Context) => {
    if (c.req.header("origin") !== localOrigin)
      return c.text("Local origin required", 403);
    const body = await c.req.text();
    if (body.length > 2_000_000) return c.text("Telemetry too large", 413);
    const payload = JSON.parse(body);
    appendFileSync(
      `${telemetryDir}/browser.ndjson`,
      JSON.stringify({ port, ...payload, release: selectedRelease }) + "\n",
    );
    return c.body(null, 204);
  };
app.post("/warbook/telemetry", receiveTelemetry(release));
if (challengerRelease)
  app.post(
    "/warbook/challenger/telemetry",
    receiveTelemetry(challengerRelease),
  );
const localConfig = (c: Context) =>
  c.text(
    `[General]\nreplaysUrlWhitelist=127.0.0.1\nbotsEnabled=yes\nquickMatchEnabled=no\nunrankedQueueEnabled=no\nlegacyRegistrationEnabled=no\nviewport.width=1280\nviewport.height=800\ndefaultLanguage=zh-TW\ngameResArchiveUrl=${localOrigin}/warbook/ra2-local.zip\nserversUrl=${localOrigin}/warbook/servers.ini\nmapsBaseUrl=${localOrigin}/game/maps/\nmodsBaseUrl=${localOrigin}/game/mods/\n`,
  );
app.get("/game/config.ini", localConfig);
app.get("/challenge/config.ini", localConfig);
app.get("/client/:version/config.ini", localConfig);
app.get("/warbook/servers.ini", (c) => c.text("[Servers]\n"));
const gamePage = (isChallenger: boolean) => async (c: Context) => {
  if (isChallenger && !challengerRelease) return c.notFound();
  const botUrl = isChallenger ? "/warbook/challenger.js" : "/warbook/bot.js";
  const telemetryUrl = isChallenger
    ? "/warbook/challenger/telemetry"
    : "/warbook/telemetry";
  const { body } = await getClientAsset("/");
  let html = body.toString();
  html = html.replace(
    "<head>",
    `<head><base href="/client/${CLIENT_VERSION}/">`,
  );
  html = html.replace(/<!-- Global site tag[\s\S]*?(?=  <link)/, "");
  html = html.replace(
    /<script>\(function\(\)\{function c\(\)[\s\S]*?<\/script>/,
    "",
  );
  if (!html.includes('SystemJS.import("main")'))
    throw new Error("Unsupported pinned client bootstrap");
  html = html.replace(
    'SystemJS.import("main")',
    `SystemJS.import('game/api/index').then(async api => {
    globalThis.WarbookEngineApi=api;
    await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src=${JSON.stringify(botUrl)};s.onload=resolve;s.onerror=reject;document.head.append(s);});
    await Warbook.install();
    await SystemJS.import('main');
  }).catch(error=>{document.body.textContent='本地 AI 启动失败：'+error.message;console.error(error);})`,
  );
  html = html.replace(
    "</head>",
    `<script>
    const originalFetch=window.fetch;
    window.fetch=function(input,init){
      if(input==='/warbook/telemetry') input=${JSON.stringify(telemetryUrl)};
      const prefix='https://unpkg.com/detect-gpu@5.0.42/dist/benchmarks/';
      if(typeof input==='string' && input.startsWith(prefix)) input='/warbook/gpu/'+input.slice(prefix.length);
      return originalFetch.call(this,input,init);
    };
    // The official importer uses its normal URL flow, with our local resource archive.
    const localImport=new MutationObserver(()=>{
      const input=document.querySelector('input[type=url]');
      const button=[...document.querySelectorAll('button')].find(b=>['Download','下載','下载'].includes(b.textContent.trim()));
      if(input && button){localImport.disconnect();setTimeout(()=>button.click(),300);}
    });
    localImport.observe(document.documentElement,{subtree:true,childList:true});
  </script></head>`,
  );
  c.header(
    "Content-Security-Policy",
    "connect-src 'self' blob:; worker-src 'self' blob:;",
  );
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Embedder-Policy", "require-corp");
  return c.html(html);
};
app.get("/game/", gamePage(false));
app.get("/challenge", (c) => c.redirect("/challenge/"));
app.get("/challenge/", gamePage(true));
const clientAsset = async (c: Context) => {
  const url = new URL(c.req.url);
  const requestedVersion = c.req.param("version");
  const build = requestedVersion
    ? CLIENT_BUILDS.get(requestedVersion)
    : LEGACY_CLIENT;
  if (!build) return c.text("Unknown client version", 404);
  const path =
    url.pathname.slice(
      requestedVersion ? `/client/${requestedVersion}`.length : "/game".length,
    ) + url.search;
  if (!/^\/(lib|dist|res)\//.test(path) && !/^\/style\.css(?:\?|$)/.test(path))
    return c.text("Unknown local client asset", 404);
  const asset = await getClientAsset(path, undefined, build);
  if (path.startsWith("/res/ra2cd.mix")) c.header("Cache-Control", "no-store");
  if (path.includes("/locale/")) {
    const strings = JSON.parse(asset.body.toString());
    strings["gui:demo"] = "本地对战";
    strings["gui:aieasybeta"] = "Warbook AI";
    return c.json(strings);
  }
  c.header("Content-Type", asset.type);
  c.header("Cross-Origin-Resource-Policy", "same-origin");
  return c.body(new Uint8Array(asset.body));
};
app.get("/game/*", clientAsset);
app.get("/client/:version/*", clientAsset);
if (process.env.REPLAY_CHECK)
  app.get(
    "/warbook/replay-check.rpl",
    serveStatic({ path: process.env.REPLAY_CHECK }),
  );
serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () =>
  console.log(`Warbook player entry: ${localOrigin}`),
);
