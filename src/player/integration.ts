import { WarbookBot, OBSERVATION_PROTOCOL } from '../bridge.js';
import { POLICY_VERSION } from '../policy.js';

declare global {
  var SystemJS: { import(name:string):Promise<any> };
  var WarbookSession: { version:string; protocol:string; sessionId:string; games:number; bots:WarbookBot[]; error?:string; lastResult?:unknown };
}

export async function install():Promise<void> {
  const [{BotFactory},{GameFactory},{SkirmishScreen},{StorageKey}]=await Promise.all([SystemJS.import('game/bot/BotFactory'),SystemJS.import('game/GameFactory'),SystemJS.import('gui/screen/mainMenu/lobby/SkirmishScreen'),SystemJS.import('LocalPrefs')]);
  const session=globalThis.WarbookSession={version:POLICY_VERSION,protocol:OBSERVATION_PROTOCOL,sessionId:crypto.randomUUID(),games:0,bots:[]} as typeof WarbookSession;
  const originalOptions=SkirmishScreen.prototype.initOptions;
  SkirmishScreen.prototype.initOptions=async function() {
    const first=!localStorage.getItem('warbook.defaults.v1');
    if(first){this.localPrefs.setItem(StorageKey.LastMap,'mp03t4.map');this.localPrefs.setItem(StorageKey.LastMode,'1');}
    await originalOptions.call(this);
    if(first){
      const country=this.getAvailablePlayerCountries().indexOf('Americans');
      this.gameOpts.humanPlayers[0].countryId=country;
      for(const ai of this.gameOpts.aiPlayers) if(ai) ai.countryId=country;
      Object.assign(this.gameOpts,{credits:10000,unitCount:0,gameSpeed:4,shortGame:true,cratesAppear:false,superWeapons:false});
      localStorage.setItem('warbook.defaults.v1','1');
    }
  };
  BotFactory.prototype.create=function(player:any) {
    const bot=new WarbookBot(player.name,player.country.name,'baseline');
    bot.autoTick=true;
    session.bots.push(bot);
    // Evidence is written locally. These records never feed the policy.
    let events:unknown[]=[];
    let lastFlush=0;
    bot.trace=(event)=>{
      if(event.kind!=='observation' && event.kind!=='own_objects_appeared') return;
      events.push(event);
      if(event.tick-lastFlush>=150 || events.length>30) {
        void fetch('/warbook/telemetry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:session.sessionId,game:session.games,events})});
        events=[];lastFlush=event.tick;
      }
    };
    return bot;
  };
  const originalCreate=GameFactory.create;
  GameFactory.create=function(...args:unknown[]) {
    session.bots=[];session.games++;
    const game=originalCreate.apply(this,args);
    game.onEnd.subscribe(()=>{
      const result={game:session.games,tick:game.currentTick,status:game.status,players:game.getCombatants().map((p:any)=>({name:p.name,defeated:p.defeated}))};
      session.lastResult=result;
      void fetch('/warbook/telemetry',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:session.sessionId,game:session.games,events:[{kind:'game_end',...result}]})});
    });
    return game;
  };
  const bar=document.createElement('div');
  bar.id='warbook-status';
  bar.style.cssText='position:fixed;z-index:10000;left:12px;bottom:8px;background:#111c25e8;color:#ccd8de;font:12px system-ui;padding:6px 10px;border:1px solid #425665;border-radius:5px;pointer-events:none';
  bar.textContent=`Warbook 本地 AI · ${POLICY_VERSION} · 点击「本地对战」开局`;
  document.body.append(bar);
  setInterval(()=>{
    const bot=session.bots[0];
    bar.textContent=bot?.observation?`Warbook 本地 AI · ${POLICY_VERSION} · ${bot.name} · ${Math.floor(bot.observation.tick/15)} 秒`:`Warbook 本地 AI · ${POLICY_VERSION} · 点击「本地对战」开局`;
  },1000);
  window.addEventListener('error',event=>{session.error=event.message;});
}
