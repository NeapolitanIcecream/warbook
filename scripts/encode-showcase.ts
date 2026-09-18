import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ReplayClipPlan } from "../src/player/replay-clips.js";

const planFile = process.argv[2];
if (!planFile) throw new Error("Usage: encode-showcase.ts <clip plan.json>");
const plan: ReplayClipPlan = JSON.parse(readFileSync(planFile, "utf8"));
const directory = resolve(`runs/showcase/${plan.version}`);
mkdirSync(directory, { recursive: true });
const hash = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const ffmpeg = (args: string[]) =>
  execFileSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const time = (tick: number) =>
  `${Math.floor(tick / 900)}:${String(Math.floor(tick / 15) % 60).padStart(2, "0")}`;
const clips = [];
for (const clip of plan.clips) {
  const input = `${directory}/${clip.id}.webm`;
  const capture = JSON.parse(
    readFileSync(`${directory}/${clip.id}.capture.json`, "utf8"),
  );
  if (
    capture.replaySha256 !== plan.replaySha256 ||
    !isDeepStrictEqual(capture.plan, clip) ||
    hash(input) !== capture.sha256
  )
    throw new Error(`Capture provenance mismatch: ${clip.id}`);
  const output = `${directory}/${clip.id}.mp4`;
  ffmpeg([
    "-i",
    input,
    "-an",
    "-vf",
    "fps=30",
    "-c:v",
    "libx264",
    "-threads",
    "2",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-maxrate",
    "1400k",
    "-bufsize",
    "2800k",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    output,
  ]);
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,size:stream=codec_name,width,height,avg_frame_rate,pix_fmt",
        "-of",
        "json",
        output,
      ],
      { encoding: "utf8" },
    ),
  );
  const expectedSeconds = (clip.endTick - clip.startTick) / 15;
  const duration = Number(probe.format.duration);
  const video = probe.streams[0];
  if (
    Math.abs(duration - expectedSeconds) > 1 ||
    video.codec_name !== "h264" ||
    video.width !== 1280 ||
    video.height !== 720 ||
    statSync(output).size >= 10_000_000
  )
    throw new Error(
      `Export needs inspection: ${clip.id} ${JSON.stringify(probe)}`,
    );
  ffmpeg([
    "-ss",
    "15",
    "-i",
    output,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    `${directory}/${clip.id}.jpg`,
  ]);
  clips.push({
    id: clip.id,
    title: clip.title,
    startTick: capture.startTick,
    endTick: capture.endTick,
    seconds: duration,
    bytes: statSync(output).size,
    sha256: hash(output),
    video,
  });
  console.log(JSON.stringify(clips.at(-1)));
}

const preview = plan.clips[0].id;
ffmpeg([
  "-ss",
  "18",
  "-t",
  "8",
  "-i",
  `${directory}/${preview}.mp4`,
  "-filter_complex",
  "[0:v]fps=10,scale=640:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3[v]",
  "-map",
  "[v]",
  "-loop",
  "0",
  `${directory}/preview.gif`,
]);
const match = JSON.parse(readFileSync(`${plan.sourceRun}/result.json`, "utf8"));
if (hash(match.replay.file) !== plan.replaySha256)
  throw new Error("Source replay changed");
copyFileSync(match.replay.file, `${directory}/match.rpl`);
writeFileSync(
  `${directory}/media.json`,
  JSON.stringify(
    {
      version: plan.version,
      replaySha256: plan.replaySha256,
      clips,
      preview: {
        bytes: statSync(`${directory}/preview.gif`).size,
        sha256: hash(`${directory}/preview.gif`),
      },
      recording:
        "Scripted camera; 15 simulation ticks per video second; silent; original replay commands unchanged",
      validation:
        "Encoded format, duration and size verified here; visual review recorded separately",
    },
    null,
    2,
  ) + "\n",
);

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Warbook ${escape(plan.version)} · 对局短片</title><style>body{margin:0;background:#0b1119;color:#e9eff5;font:17px/1.7 system-ui}main{max-width:1040px;margin:auto;padding:38px 22px 72px}h1{font-size:38px;line-height:1.2}h2{font-size:23px;margin:0 0 8px}p{color:#afbdca}article{margin:32px 0;padding:22px;background:#131e2b;border:1px solid #28384c;border-radius:12px}video{display:block;width:100%;margin:16px 0;background:#000;border-radius:6px}a{color:#dfc27e}small{color:#91a4b5}.tag{color:#dfc27e;letter-spacing:2px}</style><main><div class="tag">WARBOOK / ${escape(plan.version)}</div><h1>两段真实对局，看看 AI 如何作战。</h1><p>${escape(plan.matchLabel)}。样片保留了电厂与坦克损失。视频无声，可直接播放，无需游戏客户端。</p>${clips.map((clip) => `<article><h2>${escape(clip.title)}</h2><small>游戏时间 ${time(clip.startTick)}–${time(clip.endTick)} · ${clip.seconds.toFixed(0)} 秒 · ${(clip.bytes / 1_000_000).toFixed(1)} MB</small><video controls playsinline preload="metadata" poster="${clip.id}.jpg" src="${clip.id}.mp4"></video><a href="${clip.id}.mp4" download>下载 MP4</a></article>`).join("")}<p>这是单局行为展示；最终开发池新旧版本同为 20/24 胜，不能据此宣称整体实力提升。</p><p><a href="match.rpl" download>下载完整回放</a>（重演需兼容的 0.83.3 客户端与游戏资源） · <a href="preview.gif" download>下载 8 秒动图</a></p></main></html>`;
writeFileSync(`${directory}/index.html`, html);
writeFileSync(
  resolve("runs/showcase/index.html"),
  `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${plan.version}/"><a href="${plan.version}/">观看 Warbook ${plan.version} 对局短片</a>`,
);
console.log(`Gallery: http://127.0.0.1:8642/showcase/${plan.version}/`);
