// Read-only research instrumentation. Never writes source/maps or alters a brain decision.
// node scripts/diag-infloop.js [--n 48] [--seed 1000] [--champ runs/X/champions.json]
//   [--out docs/research/infinite-loop-traces] [--window 10] [--camera current|off]
//   [--mechanics 1] [--mechanics-only 1] [--keep-jsonl 1] [--verify 0]
// One match at a time; .jsonl.gz contains one full tick trace per scoped hit/down/death.
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createMatch } from '../src/sim/index.js';
import { loadMapPool } from '../src/hillclimb/maps.js';
import { makeHunter, hunterSpace } from '../src/brains/hunter.js';
import { defaults } from '../src/hillclimb/params.js';
import { circleFree } from '../src/sim/nav.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!process.argv[i].startsWith('--') || process.argv[i + 1] === undefined) throw Error('Expected --key value');
  args[process.argv[i].slice(2)] = process.argv[i + 1];
}
const n = +(args.n ?? 48), seed0 = +(args.seed ?? 1000), seconds = +(args.window ?? 10);
if (!Number.isInteger(n) || n < 1 || !Number.isInteger(seed0) || seconds <= 0) throw Error('Invalid n/seed/window');
if (args.camera && !['current', 'off'].includes(args.camera)) throw Error('--camera current|off');
const out = resolve(args.out ?? 'docs/research/infinite-loop-traces');
mkdirSync(dirname(out), { recursive: true });
const hash = s => createHash('sha256').update(s).digest('hex');
const sourceFiles = ['src/sim/match.js', 'src/sim/config.js', 'src/brains/survivor.js', 'src/brains/loops.js', 'src/brains/routes.js', 'src/brains/mapknow.js', 'src/brains/hunterbelief.js', 'src/brains/hunter.js'];
const source = Object.fromEntries(sourceFiles.map(f => [f, readFileSync(f, 'utf8')]));
const sourceHashes = Object.fromEntries(sourceFiles.map(f => [f, hash(source[f])]));
writeFileSync(out+'.sources.json',JSON.stringify(source,null,2)+'\n');
// Expose closure values in an IN-MEMORY copy of survivor.js. Imports still resolve to original modules.
// Only add a getter and a comma expression recording existing assignments; decisions/RNG remain identical.
let code = source['src/brains/survivor.js'];
const breakSites = {};
code = code.split('\n').map((line, i) => {
  if (!line.includes('circ = null') || line.includes('let circ = null')) return line;
  breakSites[i + 1] = line.trim();
  return line.replaceAll('circ = null', `(debugBreak = {t: obs.t, line: ${i + 1}}, circ = null)`);
}).join('\n');
if (!code.includes('      stats,\n')) throw Error('Survivor return structure changed; update debug getter injection');
code = code.replace('let mode =', 'let debugBreak = null; let mode =');
code = code.replace('      stats,\n', `      stats,
      get diagnostic() { return {mode, circ: circ && {...circ, seq: circ.seq.slice()}, fleePoint, genTarget, exploreTo, lastThreatT, chaseStartT, vaultCount: [...vaultCount], lastBreak: debugBreak}; },
`);
code = code.replace(/from '(\.[^']+)'/g, (_, p) => `from '${pathToFileURL(resolve('src/brains', p)).href}'`);
const { makeSurvivor, survivorSpace } = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const plainCode = source['src/brains/survivor.js'].replace(/from '(\.[^']+)'/g, (_, p) => `from '${pathToFileURL(resolve('src/brains', p)).href}'`);
const {makeSurvivor:plainSurvivor} = await import('data:text/javascript;base64,'+Buffer.from(plainCode).toString('base64'));
let hp = defaults(hunterSpace), sp = defaults(survivorSpace);
if (args.champ) { const champ = JSON.parse(readFileSync(args.champ, 'utf8')).champ; hp = {...hp, ...champ.hunter}; sp = {...sp, ...champ.survivor}; }
const maps = loadMapPool(args.map ?? 'maps/gas-heaven');
const inside = (p, margin = 0) => p.x >= 24 - margin && p.x <= 40 + margin && p.z >= 40 - margin && p.z <= 56 + margin;
const round = x => typeof x === 'number' && Number.isFinite(x) ? +x.toFixed(4) : x;
const copy = x => x == null ? x : JSON.parse(JSON.stringify(x, (_, v) => round(v)));
const xy = a => [round(a.x), round(a.z)];
const near = (a,b) => Math.hypot(a.x-b.x,a.z-b.z);
const fd = openSync(out + '.jsonl', 'w');
const summary = {schema: 2, args, n, seed0, seconds, sourceHashes, breakSites, params: {hunter:hp, survivor:sp}, matches:[], incidents:[], classes:{}};
const t0 = performance.now();
let nextId = 0;

export function classify(incident) {
  const fs = incident.trace, end = fs.at(-1), recent = fs.filter(f => end.t-f.t <= 3), who = incident.who;
  const tags = [];
  if (end.s.known.length < 4) tags.push('incomplete-window-knowledge');
  if (fs.some(f => f.s.blocked.length)) tags.push('blocked-window-present');
  if (fs.some(f => f.events.some(e => e.kind === 'body' && e.mover === who && e.blocker !== 'hunter'))) tags.push('teammate-contact');
  if (recent.some(f => f.s.vault)) tags.push('recent-vault');
  if (end.s.vault) tags.push('mid-vault-hit');
  if (recent.some(f => f.bl === 3)) tags.push('bloodlust-3');
  const recentVaults=incident.visits.vaults.filter(v=>v.t>=(incident.chase?.t ?? incident.t-10)-1);
  const triple=recentVaults.some((v,i)=>i>=2&&v.window===recentVaults[i-1].window&&v.window===recentVaults[i-2].window&&v.t-recentVaults[i-2].t<=3);
  const inLiveChase=fs.some(f=>f.s.obs?.self?.chased&&f.s.debug?.mode!=='chase'&&f.s.st<2);
  const busy=fs.filter(f=>f.events.some(e=>e.kind==='vaultAttempt'&&e.who===who&&!e.ok&&e.reasons.includes('busy'))).length;
  const bodyStall=fs.filter(f=>Math.hypot(...f.s.v)<1&&f.events.some(e=>e.kind==='body'&&e.mover===who&&e.blocker!=='hunter')).length;
  const hold=fs.filter(f=>f.s.debug?.circ?.holdT>=0.5&&Math.hypot(...f.s.v)<0.5&&f.t>=end.t-6).length;
  let cause;
  if (incident.type === 'death') cause = 'death:' + incident.event.cause;
  else if (incident.type === 'deepWoundDown') cause = 'deep-wound';
  else if (triple) cause='rapid-window-replanning';
  else if (inLiveChase) cause='threat-mode-drop';
  else if (bodyStall>=5) cause='teammate-obstruction';
  else if (busy>=5) cause='occupied-window-contest';
  else if (hold>=5 && (end.s.vault||recent.some(f=>f.s.vault))) cause='held-away-fast-runup';
  else if (recent.some(f => f.s.debug?.lastBreak && f.t-f.s.debug.lastBreak.t < 3 && /vaulting/.test(summary.breakSites[f.s.debug.lastBreak.line] ?? ''))) cause = 'hunter-vault-abandonment';
  else if (end.s.vault) cause = 'unsafe-vault';
  else if (recent.some(f => f.s.debug?.lastBreak && f.t-f.s.debug.lastBreak.t < 3 && /used up/.test(summary.breakSites[f.s.debug.lastBreak.line] ?? ''))) cause = 'window-budget-abandonment';
  else if (recent.some(f => f.events.some(e => e.kind === 'vaultAttempt' && e.who === who && !e.ok && e.reasons?.includes('lane')))) cause = 'vault-lane-failure';
  else if (recent.some(f => f.s.debug?.circ)) cause = 'loop-entry-or-hold';
  else cause = 'open-route-or-entry-failure';
  return {cause, tags};
}

for (let run = 0; run < (args['mechanics-only']==='1'?0:n); run++) {
  const seed = seed0 + run, map = maps[((seed % maps.length) + maps.length) % maps.length];
  const brains = [], captures = [], mk = makeSurvivor(sp);
  const m = createMatch({map, seed, ...(args.camera === 'off' ? {config:{survivor:{camera:{enabled:false}}}} : {}), hunter:(ctx) => {
    const b = makeHunter(hp)(ctx); return {decide(obs,api) {const action=b.decide(obs,api); captures[4] = {action:copy(action)}; return action; }};
  }, survivors:(ctx) => {const b = mk(ctx); brains[ctx.id] = b; return {decide(obs,api) {
    const action = b.decide(obs,api); captures[ctx.id] = {obs:copy({self:obs.self,hunter:obs.hunter,lastHunter:obs.lastHunter,terror:obs.terror,blockedWindows:obs.blockedWindows,hud:obs.hud}),action:copy(action),debug:copy(b.diagnostic)}; return action;
  }}; }});
  summary.config ??= copy(m.cfg);
  const windows = m.md.windows.map((w, wi) => ({...w, wi})).filter(w => inside(w));
  if (windows.length !== 4) throw Error(`${map.id}: expected 4 tile windows, got ${windows.length}`);
  const windowAt = cell => m.md.windows[m.winOfCell.get(cell)]?.id ?? cell;
  const corridorPairs=[];
  for(let i=0;i<windows.length;i++)for(let j=i+1;j<windows.length;j++)if(Math.abs(near(windows[i],windows[j])-13)<.01)corridorPairs.push([windows[i],windows[j]]);
  const inCorridor=p=>corridorPairs.some(([a,b])=>a.axis==='z'?p.x>a.x-2&&p.x<a.x+3&&p.z>Math.min(a.z,b.z)+1&&p.z<Math.max(a.z,b.z):p.z>a.z-2&&p.z<a.z+3&&p.x>Math.min(a.x,b.x)+1&&p.x<Math.max(a.x,b.x));
  const visits = Array.from({length:4}, (_,who) => ({who,everEntered:inside(m.survivors[who]),everEnteredCorridor:inCorridor(m.survivors[who]),entries:[],exits:[],corridorEntries:[],corridorExits:[],vaults:[],fourWindowLaps:0,lapTail:[],circuits:[],breaks:[],distanceInside:0}));
  const chases = [], ring = [], pending = [];
  const lastDown=Array(4).fill(null);
  let active = null, tickEvents = [], mover = null;
  const ev = m.ev;
  m.ev = function(type, detail) {
    const result = ev.call(this,type,detail), e = this.events.at(-1);
    if (type === 'chaseStart') {active = {id:this.chaseId,who:e.who,t:this.t,tile:inside(this.survivors[e.who],4),pos:xy(this.survivors[e.who]),vaults:[]}; chases.push(active);}
    if (type === 'chaseEnd' && active) {active.end=this.t; active.reason=e.reason; active=null;}
    const sid = e.who, s = Number.isInteger(sid) ? this.survivors[sid] : null;
    if(s&&((type==='hit'&&e.state==='downed')||type==='deepWoundDown'))lastDown[sid]=copy({seed,map:map.id,who:sid,t:this.t,pos:xy(s),event:e});
    tickEvents.push(copy({kind:'engine',...e}));
    if (s && (type === 'hit' || type === 'death' || type === 'deepWoundDown') && (inside(s,4) || (active?.who === sid && active.tile))) {
      pending.push({id:nextId++,seed,map:map.id,who:sid,t:this.t,type,event:copy(e),pos:xy(s),inTile:inside(s),inMargin:inside(s,4),chase:copy(active),lastDown:copy(lastDown[sid]),visits:copy(visits[sid])});
    }
    return result;
  };
  const applyMove = m._applyMove, free = m._free, tryVault = m._tryVault;
  m._applyMove = function(a,...rest) {const old=mover; mover=a; try {return applyMove.call(this,a,...rest);} finally {mover=old;}};
  m._free = function(...p) {const ok=free.apply(this,p); const b=this._blocker; if (!ok && b && mover && circleFree(this.coll,this.W,this.Hh,p[0],p[1],this.R) && Math.hypot(p[0]-b.x,p[1]-b.z)<2*this.R && Math.hypot(p[0]-b.x,p[1]-b.z)<Math.hypot(p[2]-b.x,p[3]-b.z)) {
    const blocker=this._blocker.id;
    if (!tickEvents.some(e=>e.kind==='body'&&e.mover===mover.id&&e.blocker===blocker)) tickEvents.push({kind:'body',t:this.t,mover:mover.id,blocker,pos:xy(mover)});
  } return ok;};
  m._tryVault = function(a,dx,dz,hunter) {
    const before=copy({pos:xy(a),runD:a.runD,runDx:a.runDx,runDz:a.runDz});
    const nearby = windows.filter(w=>near(a,{x:w.x+.5,z:w.z+.5})<2.5);
    const candidates=[];
    const ci=Math.floor(a.x),cj=Math.floor(a.z),adx=Math.abs(dx),adz=Math.abs(dz);
    for(let pass=0;pass<2;pass++) {
      const useX=pass===0?adx>=adz:adx<adz;
      if((useX?adx:adz)<0.35)continue;
      const nx=useX?(dx>0?1:-1):0,nz=useX?0:(dz>0?1:-1),wi=ci+nx,wj=cj+nz,cell=wj*this.W+wi;
      const w=this.md.windows[this.winOfCell.get(cell)]; if(!w)continue;
      const reasons=[],lateral=nx?Math.abs(a.z-(cj+.5)):Math.abs(a.x-(ci+.5));
      const along=nx>0?wi-a.x:nx<0?a.x-(wi+1):nz>0?wj-a.z:a.z-(wj+1);
      if((w.axis==='x')!==(nx!==0))reasons.push('axis');
      if(!hunter&&this.winBlockT[this.winOfCell.get(cell)*4+a.id]>this.t)reasons.push('blocked');
      if(this.coll[(cj+2*nz)*this.W+ci+2*nx]!==0)reasons.push('landing-solid');
      if(this._vaultCellBusy(cell,a))reasons.push('busy');
      if(lateral>this.cfg.reach.vaultLane)reasons.push('lane');
      if(along>this.R+.3)reasons.push('approach-distance');
      candidates.push({window:w.id,nx,nz,lateral,along,reasons});
    }
    const ok=tryVault.call(this,a,dx,dz,hunter);
    if (ok || nearby.length) {
      const reasons=candidates.flatMap(c=>c.reasons);
      if(!ok&&!candidates.length)reasons.push('no-window-in-step-direction');
      const v=a.vault, item=copy({kind:'vaultAttempt',t:this.t,who:a.id,ok,dx,dz,...before,nearby:nearby.map(w=>w.id),candidates,reasons:[...new Set(reasons)],window:ok?windowAt(v.cell):null,duration:ok?v.dur:null,tier:ok?(hunter?'hunter':this.winOfCell.has(v.cell)?v.dur===this.cfg.survivor.vaultFastS?'fast':v.dur===this.cfg.survivor.vaultMediumS?'medium':'slow':'pallet'):null});
      tickEvents.push(item);
      if (ok && !hunter && windows.some(w=>w.id===item.window)) {
        const v=visits[a.id];v.vaults.push(item);
        if(v.lapTail.includes(item.window))v.lapTail=[];
        v.lapTail.push(item.window);
        // A lap = four consecutive distinct tile windows on perimeter edges (6 m or 13 m), no repeated hold vaults.
        if(v.lapTail.length===4) {const ws=v.lapTail.map(id=>windows.find(w=>w.id===id));if(ws.every((w,i)=>{const d=near(w,ws[(i+1)%4]);return Math.abs(d-6)<.01||Math.abs(d-13)<.01;}))v.fourWindowLaps++;v.lapTail=[];}
        if(active?.who===a.id)active.vaults.push(item);
      }
    }
    return ok;
  };
  const hurt=m._hurt;
  m._hurt=function(s) {tickEvents.push(copy({kind:'attackConnect',t:this.t,who:s.id,s:xy(s),h:xy(this.hunter),distance:near(s,this.hunter),vault:s.vault,hVault:this.hunter.vault,bloodlust:this.blTier,hitPathClear:this._hitPathClear(this.hunter,s)})); return hurt.call(this,s);};
  let prior = m.survivors.map(s=>({x:s.x,z:s.z,st:s.st,vault:s.vault}));
  const lastDebug=Array(4).fill('');
  while (!m.over) {
    tickEvents=[]; const tickTime=m.tick*m.dt; m.step();
    for (const s of m.survivors) {
      const v=visits[s.id], old=prior[s.id], entered=inside(s), was=inside(old);
      if (entered && s.st<2) v.everEntered=true;
      if(inCorridor(s)&&s.st<2)v.everEnteredCorridor=true;
      if(inCorridor(s)!==inCorridor(old)) {
        const vv=s.vault??old.vault;
        (inCorridor(s)?v.corridorEntries:v.corridorExits).push(copy({t:tickTime,pos:xy(s),state:s.st,standing:s.st<2,via:vv?windowAt(vv.cell):'walk-or-carried',action:captures[s.id]?.action,debug:captures[s.id]?.debug}));
      }
      if (entered !== was) {const target=entered?v.entries:v.exits; target.push(copy({t:m.t,pos:xy(s),from:xy(old),state:s.st,standing:s.st<2,via:s.vault?windowAt(s.vault.cell):old.st===3?'carried':'walk',action:captures[s.id]?.action,debug:captures[s.id]?.debug}));}
      if (entered && s.st<2) v.distanceInside+=near(s,old);
      const debug=captures[s.id]?.debug;
      const key=JSON.stringify(debug?.circ&&[debug.circ.seq,debug.circ.i,debug.circ.phase]);
      if(key!==lastDebug[s.id]) {v.circuits.push(copy({t:m.t,circ:debug?.circ,mode:debug?.mode}));lastDebug[s.id]=key;}
      if(debug?.lastBreak && (v.breaks.at(-1)?.until??v.breaks.at(-1)?.t)!==debug.lastBreak.t) {
        const last=v.breaks.at(-1),b=debug.lastBreak;
        if(last?.line===b.line&&b.t-(last.until??last.t)<.21){last.until=b.t;last.count=(last.count??1)+1;}
        else v.breaks.push(copy(b));
      }
    }
    const h=m.hunter;
    const frame={t:round(tickTime),tick:m.tick-1,h:{pos:xy(h),face:round(h.face),action:copy(h.lastAction),vault:copy(h.vault&&{...h.vault,window:windowAt(h.vault.cell)}),windT:round(h.windT),cdT:round(h.cdT)},bl:m.blTier,chase:{target:m.chaseTgt,id:m.chaseId,seconds:round(m.blT)},events:tickEvents,s:m.survivors.map(s=>{
      const c=captures[s.id]; return {pos:xy(s),face:round(s.face),camYaw:round(s.camYaw),st:s.st,v:[round(s.vx),round(s.vz)],runD:round(s.runD),bodyT:round(s.bodyT),action:c?.action,obs:c?.obs,debug:c?.debug,vault:copy(s.vault&&{...s.vault,window:windowAt(s.vault.cell)}),known:windows.filter(w=>{const k=brains[s.id].loops.anchors.findIndex(a=>a.id===w.id);return brains[s.id].know.anchorKnown[k];}).map(w=>w.id),blocked:m._blockedWindows(s.id),windowCounts:windows.map(w=>({id:w.id,...m.winVaults[w.wi][s.id],blockedUntil:round(m.winBlockT[w.wi*4+s.id])}))};})};
    ring.push(frame); while(ring.length>Math.ceil(seconds/m.dt)+1)ring.shift();
    for (const incident of pending.splice(0)) {
      incident.visits=copy(visits[incident.who]);
      incident.trace=ring.map(f=>({...f,s:f.s[incident.who]}));
      // Preserve hit-time vault before _hurt clears/down movement and post-step terminal events.
      const connect=tickEvents.find(e=>e.kind==='attackConnect'&&e.who===incident.who);
      if(connect?.vault)incident.trace.at(-1).s={...incident.trace.at(-1).s,vault:connect.vault};
      const {cause,tags}=classify(incident); incident.cause=cause;incident.tags=tags;
      writeSync(fd,JSON.stringify(incident)+'\n');
      const {trace,visits:history,...compact}=incident;summary.incidents.push({...compact,visitSummary:{everEntered:history.everEntered,everEnteredCorridor:history.everEnteredCorridor,fourWindowLaps:history.fourWindowLaps,tileVaults:history.vaults.length,entries:history.entries.length,exits:history.exits.length,lastBreak:history.breaks.at(-1)}});
      if(incident.event.state==='downed'||incident.type==='deepWoundDown')summary.classes[cause]=(summary.classes[cause]??0)+1;
    }
    prior=m.survivors.map(s=>({x:s.x,z:s.z,st:s.st,vault:copy(s.vault)}));
  }
  summary.matches.push({seed,map:map.id,mapHash:hash(JSON.stringify(map)),durationS:m.t,windows,visits:copy(visits),chases:copy(chases),stats:m.stats,kills:m.result().kills});
  if (run===0 && args.verify!=='0') {
    const baseline=createMatch({map,seed,...(args.camera==='off'?{config:{survivor:{camera:{enabled:false}}}}:{}),hunter:makeHunter(hp),survivors:plainSurvivor(sp)});
    while(!baseline.over)baseline.step();
    const signature=x=>JSON.stringify({result:x.result(),h:[x.hunter.x,x.hunter.z],s:x.survivors.map(s=>[s.x,s.z,s.st])});
    if(signature(baseline)!==signature(m))throw Error('Instrumentation changed match outcome/events/positions');
    summary.instrumentationParity={seed,exactResultEventsAndPositions:true};
  }
  console.log(`${run+1}/${n} seed=${seed} ${map.id} t=${m.t.toFixed(1)} incidents=${summary.incidents.filter(e=>e.seed===seed).length} elapsed=${((performance.now()-t0)/1000).toFixed(1)}s`);
}
closeSync(fd);
if(args.mechanics==='1'||args['mechanics-only']==='1')summary.mechanics=runMechanics();
summary.elapsedS=(performance.now()-t0)/1000;
summary.sourceChangedDuringRun=sourceFiles.filter(f=>hash(readFileSync(f,'utf8'))!==sourceHashes[f]);
summary.traceFile=out+'.jsonl.gz';
writeFileSync(summary.traceFile,gzipSync(readFileSync(out+'.jsonl')));
if(args['keep-jsonl']!=='1')unlinkSync(out+'.jsonl');
writeFileSync(out+'.summary.json',JSON.stringify(summary)+'\n');
console.log(JSON.stringify({out,classes:summary.classes,incidents:summary.incidents.length,elapsedS:summary.elapsedS,sourceChangedDuringRun:summary.sourceChangedDuringRun},null,2));

function runMechanics() {
  // Controlled fixtures use the real v000 geometry/engine. They are separate from natural match counts.
  const map=JSON.parse(readFileSync('maps/gas-heaven/v000.json','utf8'));
  const idle=()=>({decide:()=>({})});
  const fixture=(extra={})=>{
    const x=createMatch({map,seed:1024,config:{maxMatchS:100,survivor:{camera:{enabled:false}},...extra},hunter:idle,survivors:idle});
    for(let i=1;i<4;i++)x.survivors[i].st=6;
    x.gatesPowered=true;x.hunter.x=90.5;x.hunter.z=90.5;
    x.survivors[0].x=28.5;x.survivors[0].z=42.5;x.survivors[0].st=1;
    return x;
  };
  const tour=(role,speed,block)=>{
    const x=fixture({hunter:{speed,bloodlust:[]}}),a=role==='hunter'?x.hunter:x.survivors[0];
    if(role==='hunter'){x.survivors[0].x=90.5;x.survivors[0].z=90.5;a.x=28.5;a.z=42.5;}
    const pts=[{x:28.5,z:55.5},{x:34.5,z:55.5},{x:34.5,z:53.5},{x:34.5,z:40.5},{x:28.5,z:40.5},{x:28.5,z:42.5}];
    let k=0;const accepted=[],refused=[];
    a.brain={decide:()=>{if(!a.vault&&near(a,pts[k%pts.length])<.05)k++;return {moveTo:pts[k%pts.length]};}};
    if(block){x.chaseTgt=0;x.chaseId=1;x._updateChase=()=>{};}
    const tv=x._tryVault;
    x._tryVault=function(actor,...rest){const ok=tv.call(this,actor,...rest);if(actor===a){if(ok)accepted.push(copy({t:this.t,window:this.md.windows[this.winOfCell.get(actor.vault.cell)]?.id,dur:actor.vault.dur,from:xy(actor),to:[actor.vault.x1,actor.vault.z1]}));else if(this._blockedWindows(0).length&&refused.length<4)refused.push({t:round(this.t),pos:xy(actor),blocked:this._blockedWindows(0)});}return ok;};
    while(!x.over&&x.t<90&&(block?refused.length<4:accepted.length<9))x.step();
    return {accepted,refused,lapS:accepted.length>=5?round(accepted[4].t-accepted[0].t):null,blocks:x.events.filter(e=>e.type==='windowBlocked')};
  };
  const across=fixture();across.hunter.x=28.5;across.hunter.z=40.5;across.hunter.face=Math.PI/2;
  across._resolveAttack();
  const fastRisk=[];
  for(const gap of [2.5,3,3.5,4,4.5]){
    const x=fixture(),s=x.survivors[0],h=x.hunter;s.z=42.4;s.runD=3;s.runDx=0;s.runDz=-1;h.x=28.5;h.z=s.z+gap;h.face=-Math.PI/2;
    s.brain={decide:()=>({moveTo:{x:28.5,z:39.9}})};
    h.brain={decide:()=>({act:'attack',target:0,face:{x:s.x,z:s.z}})};
    const snaps=[];
    while(!x.over&&x.t<.6&&s.st<2){x.step();snaps.push({t:round(x.t),s:xy(s),h:xy(h),vault:copy(s.vault),wind:round(h.windT)});}
    fastRisk.push({gap,hit:x.events.find(e=>e.type==='hit')??null,snaps});
  }
  return {map:map.id,survivorTour:tour('survivor',4.6,false),hunterTourBase:tour('hunter',4.6,false),hunterTourTier3:tour('hunter',5.2,false),continuousChaseBlocker:tour('survivor',4.6,true),oppositeWindowLandingHit:{distance:2,events:across.events.filter(e=>e.type==='hit')},fastVaultLunge:fastRisk};
}
