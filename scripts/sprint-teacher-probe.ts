/** Build diagnostic old-model teacher releases. Does not start a game or training. */
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { isBuiltin } from "node:module";

const {values}=parseArgs({options:{repo:{type:"string",default:"/Users/chenmohan/gits/ra2-ai"},model:{type:"string"},out:{type:"string"},route:{type:"string",default:"bastion"},arm:{type:"string",default:"projected-coarse"},cadence:{type:"string",default:"coarse75"},"source-geometry":{type:"boolean",default:false},"native-batches":{type:"boolean",default:false},"production-policy":{type:"string",default:"inventory-step"},"siege-commitment":{type:"boolean",default:false},"defended-contact-line":{type:"boolean",default:false},"pressure-escort-goals":{type:"boolean",default:false},seed:{type:"string",default:"frozen"}}});
if (!values.model || !values.out) throw new Error("Required: --model OLD_MC.json --out DIRECTORY");
if (!["bastion","pressure"].includes(values.route!) || !["direct-live","projected-coarse","projected-every","program-direct"].includes(values.arm!) || !["coarse75","every-observation"].includes(values.cadence!)) throw new Error("Invalid route/arm/cadence");
if (!["inventory-step","continuous-armor"].includes(values["production-policy"]!)) throw new Error("Invalid production policy");
if (values.arm === "direct-live" && (values["production-policy"] !== "inventory-step" || values["siege-commitment"] || values["defended-contact-line"] || values["pressure-escort-goals"])) throw new Error("Teacher intervention requires a program-interface arm");
if (values["pressure-escort-goals"] && values.route !== "pressure") throw new Error("Pressure escort goals require --route pressure");
const repo=resolve(values.repo!),out=resolve(values.out);
const model=readFileSync(resolve(values.model),"utf8");
const artifact=JSON.parse(model);
if (artifact.format!=="warbook-launch-model-v1") throw new Error("Expected old MC launch/operation artifact");
const sha=(buffer:Uint8Array|string)=>createHash("sha256").update(buffer).digest("hex");
const fileHash=(path:string)=>sha(readFileSync(path));
const {build,version}=await import(pathToFileURL(join(repo,"node_modules/esbuild/lib/main.js")).href);
const cadence=values.arm === "projected-every" || (values.arm === "program-direct" && values.cadence === "every-observation") ? "every-observation" : "strategy75";
const options={route:values.route,arm:values.arm,cadence,seed:values.seed,exposeSourceGeometry:values["source-geometry"],nativeFiniteBatches:values["native-batches"],productionPolicy:values["production-policy"],siegeCommitment:values["siege-commitment"],defendedContactLine:values["defended-contact-line"],pressureEscortGoals:values["pressure-escort-goals"]};
const policyVersion=`inheritance-probe-v2-graph-plan-v4-${values.arm}-${cadence}-${values["source-geometry"] ? "geometry" : "no-geometry"}-${values["native-batches"] ? "batches" : "single"}${values["production-policy"] === "inventory-step" ? "" : `-${values["production-policy"]}`}${values["siege-commitment"] ? "-siege-commitment" : ""}${values["defended-contact-line"] ? "-defended-contact-line" : ""}${values["pressure-escort-goals"] ? "-pressure-escort-goals" : ""}`;
const sdkPath=join(repo,"node_modules/@chronodivide/game-api/dist/index.js");
const entry=`
import {WarbookBot,OBSERVATION_PROTOCOL} from ${JSON.stringify(join(repo,"src/bridge.ts"))};
import {prepareInference,NeuralLaunchPolicy} from ${JSON.stringify(join(repo,"src/learning/model.ts"))};
import {ExperimentalOperationProvider,operationShape,isOperationSchema} from ${JSON.stringify(join(repo,"src/learning/operation.ts"))};
import {ExperimentalLaunchProvider} from ${JSON.stringify(join(repo,"src/learning/launch.ts"))};
import {contactInputFor} from ${JSON.stringify(join(repo,"src/learning/operation-contact.ts"))};
import {BastionStrategy} from ${JSON.stringify(join(repo,"src/control/bastion-strategy.ts"))};
import {PressureStrategy} from ${JSON.stringify(join(repo,"src/control/pressure-strategy.ts"))};
import {PositionTactics} from ${JSON.stringify(join(repo,"src/control/position-tactics.ts"))};
import {QueueProduction} from ${JSON.stringify(join(repo,"src/control/production.ts"))};
import {CommanderTeacher} from ${JSON.stringify(join(repo,"src/commander/teacher.ts"))};
import {FullCommander} from ${JSON.stringify(join(repo,"src/commander/controller.ts"))};
import {ProgramController} from ${JSON.stringify(join(repo,"src/commander/program.ts"))};
import {CommanderTactics} from ${JSON.stringify(join(repo,"src/commander/tactics.ts"))};
import {ProgramProduction} from ${JSON.stringify(join(repo,"src/control/program-production.ts"))};
const artifact=${model};
const options=${JSON.stringify(options)};
await prepareInference();
export const mode=${JSON.stringify(values.route)};
export const policyVersion=${JSON.stringify(policyVersion)};
export const observationProtocol=OBSERVATION_PROTOCOL;
export const commanderExecutionMode=${JSON.stringify(values["native-batches"] ? "native-finite-batches-v1" : "single-item-v1")};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function loss(source,realized) {
  return {sourceId:source.id,realizedId:realized.id,members:source.units.length,
    destinationDistance:source.destination&&realized.destination?Math.hypot(source.destination.x-realized.destination.x,source.destination.y-realized.destination.y):undefined,
    destinationPresenceChanged:!!source.destination!==!!realized.destination,
    kindChanged:source.kind!==realized.kind,bridgeChanged:!!source.destination?.onBridge!==!!realized.destination?.onBridge,
    targetChanged:source.target!==realized.target,approachChanged:!equal(source.approach,realized.approach),
    groundDestinationChanged:!equal(source.groundDestination,realized.groundDestination),threatsChanged:!equal(source.threats,realized.threats),
    sourceThreats:source.threats?.length??0,protectedAssetsChanged:!equal([...(source.protectedAssets??[])].sort(),[...(realized.protectedAssets??[])].sort()),
    ownershipChanged:!equal([...source.units].sort(),[...realized.units].sort())};
}
// Diagnostic-only injection: checked private field, no production runner or student changes.
// FullCommander itself still builds the real world, selects teacherAction, applies the
// actual ProgramController and records executionSource=teacher.
class ProbeCommander extends FullCommander {
  injected;slots=new Map();
  constructor(source) {
    super(mode,undefined,options.seed,true);
    if (!(Reflect.get(this,'teacher') instanceof CommanderTeacher) || !(Reflect.get(this,'program') instanceof ProgramController)) throw new Error('FullCommander diagnostic hook changed');
    Reflect.set(this,'program',new ProgramController('graph-plan-v4'));
    Reflect.set(this,'productionTemperatures',{queue:1,amount:1,cash:1});
    this.injected=new CommanderTeacher(mode,{source,sourceCadence:options.cadence,sourceGeometry:options.exposeSourceGeometry,productionPolicy:options.productionPolicy,siegeCommitment:options.siegeCommitment,defendedContactLine:options.defendedContactLine,pressureEscortGoals:options.pressureEscortGoals});
    Reflect.set(this,'teacher',this.injected);
  }
  launchPoints(){return this.injected.launchPoints();}
  plan(o,assessment,feedback){
    // Core calls the teacher on strategy ticks. Forward only intermediate real
    // observations here, so every-observation updates the source exactly once.
    if(options.cadence==='every-observation'&&o.tick%75!==0)this.injected.plan(o,assessment,feedback);
    const realized=super.plan(o,assessment,feedback);
    if(o.tick%75===0){
      if(this.record.encoding!=='graph-plan-v4')throw new Error('Expected frozen v4 teacher action grammar');
      const desired=this.injected.record.plan,m=[desired.combat,...(desired.additionalCombat??[])],ids=new Set(m.map(x=>x.id));
      for(const id of this.slots.keys())if(!ids.has(id))this.slots.delete(id);
      for(const x of m)if(!this.slots.has(x.id)){
        const used=new Set(this.slots.values()),free=Array.from({length:16},(_,i)=>i).find(i=>!used.has(i));
        if(free===undefined)throw new Error('Teacher exceeds actual Commander slot grammar');this.slots.set(x.id,free);
      }
      const rm=[realized.combat,...(realized.additionalCombat??[])];
      Object.assign(this.record,{inheritance:{arm:options.arm,cadence:options.cadence,sourceRecord:this.injected.sourceRecord,missionLosses:m.map(x=>loss(x,rm[this.slots.get(x.id)]))}});
    }
    return realized;
  }
}
export function createBot(name){
  const policy=new NeuralLaunchPolicy(artifact,isOperationSchema(artifact.schema)?operationShape(artifact.schema):undefined);
  const contact=contactInputFor(artifact);
  const operation=isOperationSchema(artifact.schema)?new ExperimentalOperationProvider(artifact.controlScope,'model',options.seed,policy,true,contact,artifact.maneuverScope):undefined;
  const launch=operation?undefined:new ExperimentalLaunchProvider('model',options.seed,policy,true);
  const source=mode==='pressure'?new PressureStrategy(launch,operation):new BastionStrategy('bastion',launch,operation);
  if(options.arm==='direct-live')return new WarbookBot(name,'Americans',mode,{strategy:source,tactics:new PositionTactics(),production:new QueueProduction()});
  const teacher=options.arm==='program-direct'?new CommanderTeacher(mode,{source,sourceCadence:options.cadence,sourceGeometry:options.exposeSourceGeometry,productionPolicy:options.productionPolicy,siegeCommitment:options.siegeCommitment,defendedContactLine:options.defendedContactLine,pressureEscortGoals:options.pressureEscortGoals}):new ProbeCommander(source);
  return new WarbookBot(name,'Americans',mode,{strategy:teacher,tactics:new CommanderTactics(),production:new ProgramProduction(options.nativeFiniteBatches)});
}
`;
const result=await build({absWorkingDir:repo,stdin:{contents:entry,loader:"ts",resolveDir:repo,sourcefile:"inheritance-probe-entry.ts"},bundle:true,platform:"node",format:"esm",target:"node22",mainFields:["module","main"],write:false,metafile:true,banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"},plugins:[{name:"inheritance-sdk-identity",setup(b:any){b.onResolve({filter:/^@chronodivide\/game-api$/},()=>({path:sdkPath,external:true}));}}]});
const code=result.outputFiles[0].contents;
const externals=Object.values(result.metafile.outputs).flatMap((o:any)=>o.imports).filter((x:any)=>x.external).map((x:any)=>x.path);
if (externals.some((path:string)=>path!==sdkPath && !isBuiltin(path))) throw new Error("Unexpected external dependency");
const sourceHashes=Object.fromEntries(Object.keys(result.metafile.inputs).filter(path=>path!=="inheritance-probe-entry.ts").map(path=>{const absolute=resolve(repo,path);return [relative(repo,absolute),fileHash(absolute)];}));
const release={format:"warbook-bot-v1",git:execFileSync("git",["rev-parse","HEAD"],{cwd:repo,encoding:"utf8"}).trim(),sha256:sha(code),mode:values.route,policyVersion,observationProtocol:"api-shroud-v1-pregame-map-prior",launchModelSha256:sha(model),deterministicLaunch:true,policySchema:artifact.schema,controlScope:artifact.controlScope,contactInput:artifact.contactInput,maneuverScope:artifact.maneuverScope,commanderExecutionMode:values["native-batches"] ? "native-finite-batches-v1" : "single-item-v1",apiSha256:fileHash(sdkPath),resourceSha256:fileHash(join(repo,"node_modules/@chronodivide/game-api/dist/res/ra2cd.mix")),lockSha256:fileHash(join(repo,"package-lock.json")),esbuild:version,sourceHashes,inheritance:{...options,diagnosticTeacher:true,actionEncoding:values.arm?.startsWith("projected-") ? "graph-plan-v4" : undefined,sourceModel:resolve(values.model),sourceModelSha256:sha(model),sdkExternal:sdkPath,portability:"Build on the execution host with --repo; the SDK path keeps the runtime Bot class identical"}};
// Validation before writing the final release catches observation protocol changes.
mkdirSync(out,{recursive:true});
writeFileSync(join(out,"bot.mjs"),code);
const module=await import(pathToFileURL(join(out,"bot.mjs")).href);
release.observationProtocol=module.observationProtocol;
if (module.mode!==release.mode || module.policyVersion!==release.policyVersion) throw new Error("Bundle metadata mismatch");
writeFileSync(join(out,"release.json"),JSON.stringify(release,null,2)+"\n");
console.log(JSON.stringify({release:join(out,"release.json"),modelSha256:release.launchModelSha256,arm:values.arm,cadence,bytes:code.length,sha256:release.sha256}));
