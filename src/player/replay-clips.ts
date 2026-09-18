export interface ReplayClip {
  id: string;
  title: string;
  startTick: number;
  endTick: number;
  camera: { tick: number; x: number; y: number }[];
  captions: { tick: number; text: string }[];
}

export interface ReplayClipPlan {
  version: string;
  replaySha256: string;
  matchLabel: string;
  clips: ReplayClip[];
}

const clock = (tick: number) =>
  `${Math.floor(tick / 900)}:${String(Math.floor(tick / 15) % 60).padStart(2, "0")}`;

/** A small, scripted replay director. It only reads ticks and changes the renderer's camera. */
export async function loadReplayClipControls(): Promise<(screen: any) => void> {
  const response = await fetch("/warbook/clip-plan");
  if (response.status === 404) return () => {};
  if (!response.ok) throw new Error("Could not load the local clip plan");
  const plan: ReplayClipPlan = await response.json();
  const { MapPanningHelper } = await SystemJS.import(
    "engine/util/MapPanningHelper",
  );

  return (screen) => {
    const panel = document.createElement("section");
    panel.setAttribute("aria-label", "样片录制");
    panel.style.cssText =
      "position:fixed;left:12px;top:12px;z-index:10001;background:#0b1829eb;color:white;padding:12px;border-radius:6px;font:14px system-ui;display:flex;gap:10px;align-items:center";
    const status = document.createElement("span");
    status.setAttribute("role", "status");
    status.textContent = "游戏画布录制 · 1280×720 · 无声";
    const buttons: HTMLButtonElement[] = [];
    const helper = new MapPanningHelper(screen.game.map);
    const scene = screen.playerUi.worldScene;
    const source: HTMLCanvasElement = screen.renderer.getCanvas();
    const output = document.createElement("canvas");
    output.width = 1280;
    output.height = 720;
    const ctx = output.getContext("2d")!;
    let clip: ReplayClip | undefined;
    let phase: "idle" | "seeking" | "recording" | "saving" = "idle";
    let recorder: MediaRecorder | undefined;
    let stream: MediaStream | undefined;
    let cancelled = false;
    let sourceSize = { width: 0, height: 0 };
    let started = 0;
    let startedTick = 0;
    let frames = 0;
    let lastFrame = 0;
    let maxFrameGapMillis = 0;
    let pans: { tick: number; x: number; y: number }[] = [];
    const originalRender = screen.renderer.render;

    const setBusy = (busy: boolean) =>
      buttons.forEach((button) => {
        button.disabled = busy;
      });
    const pause = () => {
      screen.game.desiredSpeed.value = Number.EPSILON;
    };
    const resume = (speed: number) => {
      screen.game.desiredSpeed.value = speed;
      if (screen.game.speed.value === Number.EPSILON)
        screen.gameTurnMgr.doGameTurn(performance.now());
    };
    const fail = (error: unknown) => {
      cancelled = true;
      if (recorder?.state === "recording") recorder.stop();
      stream?.getTracks().forEach((track) => track.stop());
      phase = "idle";
      pause();
      setBusy(false);
      screen.warbookClipId = undefined;
      status.textContent = `录制未完成：${error instanceof Error ? error.message : String(error)}`;
    };

    const pan = () => {
      if (!clip || (phase !== "seeking" && phase !== "recording")) return;
      const tick = screen.game.currentTick;
      let i = 0;
      while (i + 1 < pans.length && pans[i + 1].tick <= tick) i++;
      const a = pans[i],
        b = pans[Math.min(i + 1, pans.length - 1)];
      const t =
        a === b
          ? 0
          : Math.max(0, Math.min(1, (tick - a.tick) / (b.tick - a.tick)));
      const eased = t * t * (3 - 2 * t);
      scene.cameraPan.setPan({
        x: a.x + (b.x - a.x) * eased,
        y: a.y + (b.y - a.y) * eased,
      });
    };

    const draw = () => {
      ctx.drawImage(source, 0, 0, 1280, 720);
      ctx.fillStyle = "#0b1119ed";
      ctx.fillRect(0, 0, 1110, 76);
      ctx.fillRect(0, 650, 1280, 70);
      ctx.fillStyle = "#dfc27e";
      ctx.font = '600 25px system-ui, "PingFang SC", sans-serif';
      ctx.fillText(`WARBOOK ${plan.version}  /  ${clip!.title}`, 24, 31);
      ctx.fillStyle = "#d6dfe8";
      ctx.font = '17px system-ui, "PingFang SC", sans-serif';
      ctx.fillText(plan.matchLabel, 24, 59);
      const tick = screen.game.currentTick;
      const caption =
        clip!.captions.filter((entry) => entry.tick <= tick).at(-1)?.text ?? "";
      ctx.fillStyle = "#f3f6fa";
      ctx.font = '21px system-ui, "PingFang SC", sans-serif';
      ctx.fillText(caption, 24, 681);
      ctx.fillStyle = "#a8bacb";
      ctx.font = '14px system-ui, "PingFang SC", sans-serif';
      ctx.fillText("真实完整对局节选 · 游戏时钟 1× · 无声", 24, 708);
      ctx.textAlign = "right";
      ctx.fillStyle = "#dfc27e";
      ctx.font = "600 23px ui-monospace, monospace";
      ctx.fillText(clock(tick), 1254, 693);
      ctx.textAlign = "left";
    };

    const begin = () => {
      const mimeType = "video/webm;codecs=vp8";
      if (!MediaRecorder.isTypeSupported(mimeType))
        throw new Error("此浏览器不支持 WebM/VP8 画布录制");
      if (
        source.width < 1280 ||
        Math.abs(source.width / source.height - 1280 / 720) > 0.02
      )
        throw new Error("请将录制页面视口设为 1280×720");
      sourceSize = { width: source.width, height: source.height };
      started = lastFrame = performance.now();
      startedTick = screen.game.currentTick;
      frames = maxFrameGapMillis = 0;
      cancelled = false;
      const chunks: Blob[] = [];
      draw();
      stream = output.captureStream(30);
      recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 5_000_000,
      });
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => fail(new Error("浏览器编码失败"));
      recorder.onstop = async () => {
        stream?.getTracks().forEach((track) => track.stop());
        if (cancelled) return;
        try {
          const report = {
            replaySha256: plan.replaySha256,
            clipId: clip!.id,
            startTick: startedTick,
            endTick: screen.game.currentTick,
            wallSeconds: (performance.now() - started) / 1000,
            sourceSize,
            outputSize: { width: 1280, height: 720 },
            mimeType,
            framesDrawn: frames,
            maxFrameGapMillis,
          };
          const form = new FormData();
          form.append(
            "video",
            new Blob(chunks, { type: mimeType }),
            `${clip!.id}.webm`,
          );
          form.append("report", JSON.stringify(report));
          const saved = await fetch(`/warbook/clips/${clip!.id}`, {
            method: "POST",
            body: form,
          });
          if (!saved.ok) throw new Error(await saved.text());
          status.textContent = `${clip!.title}：已保存 ${clock(startedTick)}–${clock(report.endTick)}`;
          phase = "idle";
          screen.warbookClipId = undefined;
          setBusy(false);
        } catch (error) {
          fail(error);
        }
      };
      recorder.start(1000);
      phase = "recording";
    };

    const afterRender = () => {
      if (!clip) return;
      const tick = screen.game.currentTick;
      if (phase === "seeking") {
        // Slow down before the cut so fast-forward frames are never part of a clip.
        if (tick >= clip.startTick - 60) screen.game.desiredSpeed.value = 1;
        status.textContent = `${clip.title}：定位 ${clock(tick)} → ${clock(clip.startTick)}`;
        if (tick >= clip.startTick) begin();
      }
      if (phase !== "recording") return;
      if (
        source.width !== sourceSize.width ||
        source.height !== sourceSize.height
      )
        throw new Error("录制过程中页面尺寸发生变化，请重录");
      draw();
      const now = performance.now();
      maxFrameGapMillis = Math.max(maxFrameGapMillis, now - lastFrame);
      lastFrame = now;
      frames++;
      status.textContent = `${clip.title}：录制 ${clock(tick)} / ${clock(clip.endTick)}`;
      if (tick >= clip.endTick) {
        phase = "saving";
        pause();
        recorder!.stop();
        status.textContent = `${clip.title}：正在保存到本机`;
      }
    };

    const render = function (this: any, ...args: unknown[]) {
      originalRender.apply(this, args);
      try {
        afterRender();
      } catch (error) {
        fail(error);
      }
    };
    screen.renderer.render = render;
    scene.onBeforeCameraUpdate.subscribe(pan);

    const arm = async (next: ReplayClip) => {
      screen.warbookReviewTick = undefined;
      screen.warbookClipId = next.id;
      setBusy(true);
      if (screen.game.currentTick > next.startTick) {
        const params = screen.params;
        await screen.onLeave();
        await screen.onEnter(params);
        return;
      }
      clip = next;
      pans = next.camera.map((entry) => ({
        tick: entry.tick,
        ...helper.computeCameraPanFromTile(entry.x, entry.y),
      }));
      phase = "seeking";
      resume(
        screen.game.currentTick >= next.startTick - 60
          ? 1
          : screen.baseSpeed * 8,
      );
    };
    for (const entry of plan.clips) {
      const button = document.createElement("button");
      button.textContent = `录制：${entry.title}`;
      button.onclick = () => {
        button.blur();
        void arm(entry).catch(fail);
      };
      buttons.push(button);
      panel.append(button);
    }
    panel.append(status);
    document.body.append(panel);
    screen.disposables.add(() => {
      cancelled = true;
      if (recorder?.state === "recording") recorder.stop();
      stream?.getTracks().forEach((track) => track.stop());
      scene.onBeforeCameraUpdate.unsubscribe(pan);
      if (screen.renderer.render === render)
        screen.renderer.render = originalRender;
      panel.remove();
    });
    const pending = plan.clips.find(
      (entry) => entry.id === screen.warbookClipId,
    );
    if (pending) void arm(pending).catch(fail);
  };
}
