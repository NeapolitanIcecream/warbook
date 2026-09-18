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
if (!Number.isFinite(plan.playbackRate) || plan.playbackRate < 4)
  throw new Error("Showcase playback must be at least 4x");
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
    capture.overlayText !== false ||
    capture.gameTicksPerSecond !== 15 ||
    !isDeepStrictEqual(capture.plan, clip) ||
    hash(input) !== capture.sha256
  )
    throw new Error(`Capture provenance mismatch: ${clip.id}`);
  const fileName = `${clip.id}-${plan.playbackRate}x.mp4`;
  const posterName = `${clip.id}-${plan.playbackRate}x.jpg`;
  const output = `${directory}/${fileName}`;
  const expectedSeconds =
    (clip.endTick - clip.startTick) / 15 / plan.playbackRate;
  ffmpeg([
    "-i",
    input,
    "-an",
    "-vf",
    `setpts=(PTS-STARTPTS)/${plan.playbackRate},fps=30`,
    "-t",
    String(expectedSeconds),
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
  const duration = Number(probe.format.duration);
  const video = probe.streams[0];
  if (
    Math.abs(duration - expectedSeconds) > 0.15 ||
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
    String(duration / 3),
    "-i",
    output,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    `${directory}/${posterName}`,
  ]);
  copyFileSync(output, `${directory}/${clip.id}.mp4`);
  copyFileSync(`${directory}/${posterName}`, `${directory}/${clip.id}.jpg`);
  clips.push({
    id: clip.id,
    fileName,
    posterName,
    title: clip.title,
    startTick: capture.startTick,
    endTick: capture.endTick,
    seconds: duration,
    playbackRate: plan.playbackRate,
    overlayText: false,
    bytes: statSync(output).size,
    sha256: hash(output),
    video,
  });
  console.log(JSON.stringify(clips.at(-1)));
}

const previewFile = `preview-${plan.playbackRate}x.gif`;
ffmpeg([
  "-ss",
  String(Math.max(0, Math.min(18 / plan.playbackRate, clips[0].seconds - 8))),
  "-t",
  "8",
  "-i",
  `${directory}/${clips[0].fileName}`,
  "-filter_complex",
  "[0:v]fps=10,scale=640:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3[v]",
  "-map",
  "[v]",
  "-loop",
  "0",
  `${directory}/${previewFile}`,
]);
copyFileSync(`${directory}/${previewFile}`, `${directory}/preview.gif`);
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
        fileName: previewFile,
        playbackRate: plan.playbackRate,
        bytes: statSync(`${directory}/${previewFile}`).size,
        sha256: hash(`${directory}/${previewFile}`),
      },
      recording: `Original game canvas; no added text; ${plan.playbackRate}x playback; silent; original replay commands unchanged`,
      validation:
        "Encoded format, duration and size verified here; visual review recorded separately",
    },
    null,
    2,
  ) + "\n",
);

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Warbook ${escape(plan.version)}</title><style>body{margin:0;background:#0b1119;color:#e9eff5;font:17px/1.7 system-ui}main{max-width:1040px;margin:auto;padding:32px 22px 60px}h1{font-size:30px;margin-bottom:4px}h2{font-size:22px;margin:0}article{margin:26px 0;padding:20px;background:#131e2b;border:1px solid #28384c;border-radius:10px}video{display:block;width:100%;margin:14px 0;background:#000;border-radius:5px}a{color:#dfc27e}small{color:#91a4b5}</style><main><h1>Warbook ${escape(plan.version)}</h1><small>${plan.playbackRate}× · 720p · 无声</small>${clips.map((clip) => `<article><h2>${escape(clip.title)}</h2><small>${time(clip.startTick)}–${time(clip.endTick)} · ${clip.seconds.toFixed(1)} 秒 · ${(clip.bytes / 1_000_000).toFixed(1)} MB</small><video controls playsinline preload="metadata" poster="${clip.posterName}?v=${clip.sha256.slice(0, 12)}" src="${clip.fileName}?v=${clip.sha256.slice(0, 12)}"></video><a href="${clip.fileName}" download>下载 MP4</a></article>`).join("")}<a href="${previewFile}" download>GIF</a> · <a href="match.rpl" download>完整回放</a></main></html>`;
writeFileSync(`${directory}/index.html`, html);
writeFileSync(
  resolve("runs/showcase/index.html"),
  `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${plan.version}/"><a href="${plan.version}/">观看 Warbook ${plan.version} 对局短片</a>`,
);
console.log(`Gallery: http://127.0.0.1:8642/showcase/${plan.version}/`);
