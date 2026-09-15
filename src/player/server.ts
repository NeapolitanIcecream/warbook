import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const CLIENT_VERSION='0.84.0';
const CLIENT_HASH='b937a130b6a1a6c9619b159769580331e08e7059bb2181758aef243753ba1bd1';
const upstream='https://game.chronodivide.com';
const cacheDir=resolve('work/client-cache');
const telemetryDir=resolve('runs/player');
mkdirSync(cacheDir,{recursive:true});mkdirSync(telemetryDir,{recursive:true});
const port=Number(process.env.PORT??8642);
const localOrigin=`http://127.0.0.1:${port}`;
const pending=new Map<string,Promise<{body:Buffer;type:string}>>();

async function getClientAsset(path:string, sourceUrl=upstream+path):Promise<{body:Buffer;type:string}> {
  const key=createHash('sha256').update(path).digest('hex');
  const file=`${cacheDir}/${key}`;
  if(existsSync(file) && existsSync(file+'.json')) return {body:readFileSync(file),type:JSON.parse(readFileSync(file+'.json','utf8')).type};
  if(process.env.OFFLINE==='1') throw new Error(`Client asset is not cached: ${path}`);
  if(pending.has(path)) return pending.get(path)!;
  const task=(async()=>{
    const response=await fetch(sourceUrl,{signal:AbortSignal.timeout(45000)});
    if(!response.ok) throw new Error(`Official asset returned ${response.status}: ${path}`);
    const body=Buffer.from(await response.arrayBuffer());
    const hash=createHash('sha256').update(body).digest('hex');
    if(path.startsWith('/dist/ra2web.min.js') && hash!==CLIENT_HASH) throw new Error('Official engine changed; update integration after verification.');
    const type=response.headers.get('content-type')??'application/octet-stream';
    writeFileSync(file,body);writeFileSync(file+'.json',JSON.stringify({path,type,sha256:hash,bytes:body.length}));
    console.log('Cached',path,body.length);
    return {body,type};
  })();
  pending.set(path,task);
  try{return await task;}finally{pending.delete(path);}
}

// Use the original local MIX files. The archive is a disposable import artifact.
const archive=resolve('assets/ra2-local.zip');
if(!existsSync(archive)) {
  const mixDir=resolve(process.env.MIX_DIR??'assets/ra2');
  execFileSync('zip',['-0','-j',archive,...['ra2.mix','language.mix','multi.mix'].map(name=>`${mixDir}/${name}`)],{stdio:'ignore'});
}
const app=new Hono();
app.use('*',async(c,next)=>{
  c.header('Cross-Origin-Opener-Policy','same-origin');
  c.header('Cross-Origin-Embedder-Policy','require-corp');
  await next();
});
app.onError((error,c)=>{console.error(error.message);return c.text(error.message,500);});
app.get('/favicon.ico',c=>c.body(null,204));
app.get('/warbook/gpu/:file',async c=>{
  const file=c.req.param('file');
  if(!/^[a-z0-9-]+\.json$/.test(file)) return c.text('Unknown benchmark',404);
  const asset=await getClientAsset('/gpu/'+file,'https://unpkg.com/detect-gpu@5.0.42/dist/benchmarks/'+file);
  return c.body(new Uint8Array(asset.body),200,{'Content-Type':asset.type});
});
app.get('/',c=>c.html(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Warbook · 本地对战</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1119;color:#e5ebf0;font:17px/1.65 system-ui}main{max-width:680px;padding:48px}small{color:#8cabb8;letter-spacing:3px}h1{font-size:52px;margin:12px 0}p{color:#adbac7}.start{display:inline-block;padding:14px 28px;background:#c9aa65;color:#111820;text-decoration:none;font-weight:700;border-radius:5px;margin:20px 0}li{margin:6px 0}footer{margin-top:40px;font-size:13px;color:#758793}</style><main><small>WARBOOK / LOCAL PLAY</small><h1>指挥你的下一场战役。</h1><p>在红色警戒 2 的完整战场上，与 Warbook AI 对战。</p><a class="start" href="/game/">开始本地对战 →</a><ol><li>选择「本地对战」，点击「开始游戏」。</li><li>选择美国，展开基地车，建设基地并作战。</li><li>按 Esc 退出；回到菜单即可再次开局。</li></ol><p>首次打开会自动导入本机游戏资源，稍候即可。</p><footer>研发试玩版 · 引擎 ${CLIENT_VERSION} · AI 使用已探索区域的 API 观察。<br>支持基本建设、采矿、补兵和地面战斗；仍在持续改进。</footer></main></html>`));
app.get('/warbook/health',c=>c.json({ok:true,engine:CLIENT_VERSION,offline:process.env.OFFLINE==='1'}));
app.get('/warbook/bot.js',serveStatic({path:'dist/player/bot.js'}));
app.get('/warbook/bot.js.map',serveStatic({path:'dist/player/bot.js.map'}));
app.get('/warbook/ra2-local.zip',serveStatic({path:'assets/ra2-local.zip'}));
app.post('/warbook/telemetry',async c=>{
  if(c.req.header('origin')!==localOrigin) return c.text('Local origin required',403);
  const body=await c.req.text();
  if(body.length>2_000_000) return c.text('Telemetry too large',413);
  JSON.parse(body);
  appendFileSync(`${telemetryDir}/browser.ndjson`,body+'\n');
  return c.body(null,204);
});
app.get('/game/config.ini',c=>c.text(`[General]\nbotsEnabled=yes\nquickMatchEnabled=no\nunrankedQueueEnabled=no\nlegacyRegistrationEnabled=no\nviewport.width=1280\nviewport.height=800\ndefaultLanguage=zh-TW\ngameResArchiveUrl=${localOrigin}/warbook/ra2-local.zip\nserversUrl=${localOrigin}/warbook/servers.ini\nmapsBaseUrl=${localOrigin}/game/maps/\nmodsBaseUrl=${localOrigin}/game/mods/\n`));
app.get('/warbook/servers.ini',c=>c.text('[Servers]\n'));
app.get('/game/',async c=>{
  const {body}=await getClientAsset('/');
  let html=body.toString();
  html=html.replace(/<!-- Global site tag[\s\S]*?(?=  <link)/,'');
  html=html.replace(/<script>\(function\(\)\{function c\(\)[\s\S]*?<\/script>/,'');
  html=html.replace('SystemJS.import("main");',`SystemJS.import('game/api/index').then(async api => {
    globalThis.WarbookEngineApi=api;
    await new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='/warbook/bot.js';s.onload=resolve;s.onerror=reject;document.head.append(s);});
    await Warbook.install();
    await SystemJS.import('main');
  }).catch(error=>{document.body.textContent='本地 AI 启动失败：'+error.message;console.error(error);});`);
  html=html.replace('</head>',`<script>
    const originalFetch=window.fetch;
    window.fetch=function(input,init){
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
  </script></head>`);
  c.header('Content-Security-Policy',"connect-src 'self' blob:; worker-src 'self' blob:;");
  c.header('Cross-Origin-Opener-Policy','same-origin');c.header('Cross-Origin-Embedder-Policy','require-corp');
  return c.html(html);
});
app.get('/game/*',async c=>{
  const url=new URL(c.req.url);
  const path=url.pathname.slice('/game'.length)+url.search;
  if(!/^\/(lib|dist|res)\//.test(path) && !/^\/style\.css(?:\?|$)/.test(path)) return c.text('Unknown local client asset',404);
  const asset=await getClientAsset(path);
  if(path.includes('/locale/')) {
    const strings=JSON.parse(asset.body.toString());
    strings['gui:demo']='本地对战';
    return c.json(strings);
  }
  c.header('Content-Type',asset.type);c.header('Cross-Origin-Resource-Policy','same-origin');
  return c.body(new Uint8Array(asset.body));
});
serve({fetch:app.fetch,hostname:'127.0.0.1',port},()=>console.log(`Warbook player entry: ${localOrigin}`));
