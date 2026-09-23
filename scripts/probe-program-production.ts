import { Bot,cdapi,type GameInstanceApi } from "@chronodivide/game-api";
import { mkdirSync,writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { WarbookBot } from "../src/bridge.js";
import { ProgramProduction } from "../src/control/program-production.js";
import { CommanderTactics } from "../src/commander/tactics.js";
import type { StrategicController,ProgramProductionPlan,StrategicPlan } from "../src/control/contracts.js";

const out=resolve(process.argv[2]??"runs/commander-production-probe");mkdirSync(out,{recursive:true});
let phase=0,last=-1,seenPower=false;const receipts:unknown[]=[];
const strategy:StrategicController={
  id:"explicit-production-action-probe",observationScope:"commander-v1",
  assessmentRequest:()=>({unitType:"MTNK",factoryType:"GAWEAP"}),
  plan(o):StrategicPlan<ProgramProductionPlan>{
    const q=o.queues.find(q=>q.type===0)!,power=o.own.find(u=>u.name==="GAPOWR"&&u.buildStatus===1);
    if(phase===0&&o.own.some(u=>u.yard))phase=1;
    else if(phase===1&&q.status===1)phase=2;
    else if(phase===2&&q.status===2)phase=3;
    else if(phase===3&&q.status===1)phase=4;
    else if(phase===4&&q.size===0)phase=5;
    else if(phase===5&&power){phase=6;seenPower=true;}
    else if(phase===6&&seenPower&&!o.own.some(u=>u.name==="GAPOWR"))phase=7;
    if(last!==phase){receipts.push({phase,tick:o.tick,queueStatus:q.status,queueSize:q.size,credits:o.credits,power:!!power});last=phase;}
    return {tick:o.tick,combat:{id:"idle",revision:0,kind:"hold",units:[],objective:"preserve-native",engagement:{allowCrush:false}},
      production:{id:"probe-program",revision:phase,deploymentUnits:phase===0?o.own.filter(u=>u.mcv).map(u=>u.ref):[],
        program:{queues:phase===0||phase>=6?[]:[{queue:0,mode:phase===2?"pause":phase===4?"cancel":"run",product:"GAPOWR",target:1,reserve:0}],
          placements:phase===5?o.buildSites.filter(p=>p.name==="GAPOWR"):[],repair:[],sell:phase===6&&power?[power.ref]:[]}}};
  },
};
class Passive extends Bot{}
let game:GameInstanceApi|undefined;
try {
  await cdapi.init(resolve(process.env.MIX_DIR??"assets/ra2"));
  const actor=new WarbookBot("ProgramProbe","Americans","bastion",{strategy,production:new ProgramProduction(),tactics:new CommanderTactics()});
  game=await cdapi.createGame({mapName:"mp06t2.map",gameMode:1,shortGame:false,mcvRepacks:true,cratesAppear:false,superWeapons:false,gameSpeed:4,credits:10000,unitCount:0,buildOffAlly:false,agents:[actor,new Passive("Passive","Americans")]});
  while(game.getCurrentTick()<4500&&phase<7){actor.submit(actor.decide(actor.observe()));await game.update();}
  const result={protocol:"pinned-public-actions",phase,passed:phase===7,receipts,scope:"Mechanism test; not a complete-game win"};
  writeFileSync(out+"/report.json",JSON.stringify(result,null,2)+"\n");console.log(JSON.stringify(result));if(!result.passed)process.exitCode=1;
} finally {game?.dispose();}
