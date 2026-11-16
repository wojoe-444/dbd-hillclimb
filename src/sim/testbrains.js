// Trivial baseline brains -- just enough to exercise every mechanic. NOT meant to be good.
// Rules for brains (see README): no module-level mutable state, no communication between instances.
// Everything a brain remembers lives inside its factory closure.

import { makeSlotPicker } from './slotpick.js';

const hyp = (a, b) => Math.sqrt(a * a + b * b);

function rectDist(x, z, x0, z0, x1, z1) {
  const dx = x < x0 ? x0 - x : (x > x1 ? x - x1 : 0);
  const dz = z < z0 ? z0 - z : (z > z1 ? z - z1 : 0);
  return hyp(dx, dz);
}

export function survivorBrain(ctx) {
  const { generators: gens, pallets, exitGates, hooks } = ctx.map;
  let genTarget = -1;
  const slots = makeSlotPicker(ctx.config.reach.repairSlot);
  let holdUntil = -1;          // stand still (accept a heal) until this time

  return {
    decide(obs, api) {
      const me = obs.self, nav = api.nav, h = obs.hunter;
      // hooked: the minimal hooked obs; take the Resolve self-unhook the moment it is offered, else ask for help
      if (me.state === 'hooked') return me.canSelfUnhook ? { act: 'selfUnhook' } : { intent: 'help' };
      if (me.state === 'carried') return { act: 'wiggle' };
      if (me.state === 'downed') {
        // crawl out through an open gate if possible, else away from a visible hunter, else lie still (recover)
        for (const g of obs.gates) if (g.open) { const gd = exitGates.find(x => x.id === g.id); return { moveTo: { x: gd.exit.x, z: gd.exit.z } }; }
        if (h) { const dx = me.x - h.x, dz = me.z - h.z; return { moveDir: { x: dx, z: dz } }; }
        return {};
      }
      // a teammate right next to me says it's healing me: stand still for a moment (healing needs a stationary patient)
      for (const n of obs.newNotifications) {
        if (n.type !== 'intent' || n.intent !== 'healing') continue;
        const t = obs.teammates.find(x => x.id === n.from);
        if (t && hyp(t.x - me.x, t.z - me.z) <= 2.5 && me.state !== 'healthy') holdUntil = obs.t + 3;
      }
      if (obs.t < holdUntil && !h) return {};
      if (me.deepWoundS !== null && !h) return { act: 'mend' };              // self-mend Deep Wound

      // ---- hunter in sight: pallets first, then run ----
      if (h) {
        const intent = me.chased ? 'chasingMe' : undefined;
        const dh = hyp(h.x - me.x, h.z - me.z);
        if (dh <= 3.0) {
          for (let i = 0; i < pallets.length; i++) {
            const p = pallets[i];
            if (obs.pallets[i] === 'up' && rectDist(me.x, me.z, p.x0, p.z0, p.x1, p.z1) <= 1.1) return { act: 'dropPallet', target: p.id };
          }
        }
        // run to an up pallet we can reach before the hunter does
        let best = null, bd = Infinity;
        for (let i = 0; i < pallets.length; i++) {
          if (obs.pallets[i] !== 'up') continue;
          const p = pallets[i], pc = { x: p.cx, z: p.cz };
          const dm = nav.dist(me, pc);
          if (dm < bd && dm < 25 && dm < hyp(h.x - p.cx, h.z - p.cz) * 0.9) { bd = dm; best = pc; }
        }
        if (best) return { moveTo: best, intent };
        // else just flee (prefer the farthest generator from the hunter, else straight away)
        let far = null, fd = -1;
        for (const g of gens) { const d = hyp(g.x - h.x, g.z - h.z); if (d > fd && nav.dist(me, g) < 1e8) { fd = d; far = g; } }
        if (far && fd > dh) return { moveTo: far };
        return { moveDir: { x: me.x - h.x, z: me.z - h.z } };
      }

      // ---- teammates: rescue hooked, heal injured ----
      for (const t of obs.teammates) {
        if (t.state === 'hooked') {
          let hk = null, bd = Infinity;
          for (const k of hooks) { const d = hyp(k.x - t.x, k.z - t.z); if (d < bd) { bd = d; hk = k; } }
          if (hk && hyp(hk.x - me.x, hk.z - me.z) <= 1.6) return { act: 'rescue', target: t.id };
          if (hk) return { moveTo: { x: hk.x, z: hk.z } };
        }
      }
      for (const t of obs.teammates) {   // mend a teammate's Deep Wound (HUD shows it)
        if (t.state === 'injured' && obs.hud[t.id].deepWound !== null && me.deepWoundS === null) {
          if (hyp(t.x - me.x, t.z - me.z) <= 1.5) return { act: 'mend', target: t.id };
          return { moveTo: { x: t.x, z: t.z } };
        }
      }
      for (const t of obs.teammates) {
        if ((t.state === 'injured' || t.state === 'downed') && me.state === 'healthy') {
          if (hyp(t.x - me.x, t.z - me.z) <= 1.5) return { act: 'heal', target: t.id, intent: t.state === 'injured' ? 'healing' : undefined };
          return { moveTo: { x: t.x, z: t.z } };
        }
      }

      // ---- endgame: open a gate and leave ----
      if (obs.gatesPowered) {
        let g = null, bd = Infinity;
        for (const c of obs.gates) { const gd = exitGates.find(x => x.id === c.id); const d = nav.dist(me, c.open ? gd.exit : gd.lever); if (d < bd) { bd = d; g = c; } }
        if (g) {
          const gd = exitGates.find(x => x.id === g.id);
          // a teammate is crawling out: wait at the lever (leaving would end the match for them: all-down rule)
          if (g.open && obs.downedAuras.length && obs.endgame && obs.endgame.remainingS > 15) return { moveTo: { x: gd.lever.x, z: gd.lever.z } };
          if (g.open) return { moveTo: { x: gd.exit.x, z: gd.exit.z } };
          if (hyp(gd.lever.x - me.x, gd.lever.z - me.z) <= 1.4) return { act: 'openGate', target: g.id };
          return { moveTo: { x: gd.lever.x, z: gd.lever.z } };
        }
      }

      // ---- generators ----
      if (genTarget >= 0 && obs.gens[genTarget].done) genTarget = -1;
      if (genTarget < 0) {
        let bd = Infinity;
        for (let i = 0; i < gens.length; i++) {
          if (obs.gens[i].done) continue;
          const d = nav.dist(me, gens[i]);
          if (d < bd) { bd = d; genTarget = i; }
        }
      }
      if (genTarget >= 0) {
        const a = slots.act(obs, genTarget, gens[genTarget]);   // walk to a free side slot, repair there
        return a.act === 'repair' && me.act !== 'repair' ? { ...a, intent: 'goingForGen' } : a;
      }
      return {};
    },
  };
}

export function hunterBrain(ctx) {
  const { generators: gens, hooks, pallets } = ctx.map;
  let patrol = 0;
  let lastGoto = null;
  let pdTick = -99, pdCache = 0;
  let hookTarget = null;
  let hookN = 0, campHook = null, campUntil = -1;   // camp every 2nd hook for 45 s (exercises Resolve)

  return {
    decide(obs, api) {
      const me = obs.self, nav = api.nav;

      if (me.carrying === null) hookTarget = null;
      // ---- carrying: drop to chase if the collapse is on or a standing survivor is right there, else hook ----
      if (me.carrying !== null && (obs.endgame || obs.survivors.some(s => (s.state === 'healthy' || s.state === 'injured') && hyp(s.x - me.x, s.z - me.z) < 3))) return { act: 'drop' };
      if (me.carrying !== null) {
        if (hookTarget === null || obs.hooked.some(x => x.hookId === hookTarget.id)) {   // pick once per carry
          const taken = new Set(obs.hooked.map(x => x.hookId));
          let bd = Infinity; hookTarget = null;
          for (const k of hooks) { if (taken.has(k.id)) continue; const d = nav.dist(me, k); if (d < bd) { bd = d; hookTarget = k; } }
        }
        const hk = hookTarget;
        if (!hk) return {};
        if (hyp(hk.x - me.x, hk.z - me.z) <= 1.3) {
          if (me.act === 'hook' && me.progress >= ctx.config.hunter.hookS - 0.15 && ++hookN % 2 === 0) { campHook = hk; campUntil = obs.t + 45; }
          return { act: 'hook', target: hk.id };
        }
        return { moveTo: { x: hk.x, z: hk.z } };
      }

      // ---- visible survivors ----
      if (obs.survivors.length && !obs.endgame) {   // (the baseline gives up chasing once the collapse runs)
        const vis = obs.survivors.filter(s => s.state !== 'hooked' && s.state !== 'carried');
        let tgt = null, bd = Infinity;
        for (const s of vis) {
          const d = hyp(s.x - me.x, s.z - me.z) + (s.state === 'downed' ? -100 : 0);
          if (d < bd) { bd = d; tgt = s; }
        }
        if (tgt) {
          const d = hyp(tgt.x - me.x, tgt.z - me.z);
          if (tgt.state === 'downed') {
            if (d <= 1.4) return { act: 'pickup', target: tgt.id };
            return { moveTo: { x: tgt.x, z: tgt.z } };
          }
          if (obs.tick - pdTick >= 5) { pdTick = obs.tick; pdCache = d > 3 ? nav.dist(me, tgt) / d : 1; }   // path/straight ratio, refreshed every 0.5 s
          if (pdCache > 3 && d > 2) {
            // blocked (probably by a dropped pallet): go break the nearest one
            let bp = null, bpd = Infinity;
            for (let i = 0; i < pallets.length; i++) {
              if (obs.pallets[i] !== 'dropped') continue;
              const p = pallets[i], pdx = hyp(p.cx - me.x, p.cz - me.z);
              if (pdx < bpd) { bpd = pdx; bp = p; }
            }
            if (bp) {
              if (bpd <= 2.0) return { act: 'breakPallet', target: bp.id };
              return { moveTo: { x: bp.cx, z: bp.cz } };
            }
          }
          if (d <= 2.0) return { act: 'attack', target: tgt.id, face: { x: tgt.x, z: tgt.z } };
          return { moveTo: { x: tgt.x, z: tgt.z } };
        }
      }

      // ---- camping a fresh hook ----
      if (campHook && obs.t < campUntil && obs.hooked.some(x => x.hookId === campHook.id)) {
        if (hyp(campHook.x - me.x, campHook.z - me.z) > 2.5) return { moveTo: { x: campHook.x, z: campHook.z } };
        return {};
      }
      campHook = null;

      // ---- investigate sounds / marks / notifications ----
      for (const n of obs.newNotifications) if (n.x !== undefined) lastGoto = { x: n.x, z: n.z };
      if (obs.grunts.length) { const g = obs.grunts[obs.grunts.length - 1]; lastGoto = { x: g.x, z: g.z }; }
      if (obs.scratches.length) { const g = obs.scratches[obs.scratches.length - 1]; lastGoto = { x: g.x + g.dx * 3, z: g.z + g.dz * 3 }; }
      if (lastGoto) {
        if (hyp(lastGoto.x - me.x, lastGoto.z - me.z) < 2.5) lastGoto = null;
        else return { moveTo: lastGoto };
      }

      // ---- gates powered, nobody in sight, no collapse yet: open the nearest gate (starts the collapse) ----
      if (obs.gatesPowered && !obs.endgame) {
        let gd = null, bd = Infinity;
        for (const g of ctx.map.exitGates) { const d = hyp(g.lever.x - me.x, g.lever.z - me.z); if (d < bd) { bd = d; gd = g; } }
        if (gd) return bd <= 1.3 ? { act: 'openGate', target: gd.id } : { moveTo: { x: gd.lever.x, z: gd.lever.z } };
      }

      // ---- patrol generators (most progressed first) ----
      const order = gens.map((g, i) => i).filter(i => !obs.gens[i].done).sort((a, b) => obs.gens[b].progress - obs.gens[a].progress);
      if (!order.length) return {};
      const g = gens[order[patrol % order.length]];
      if (hyp(g.x - me.x, g.z - me.z) < 4) patrol++;
      return { moveTo: { x: g.x, z: g.z } };
    },
  };
}
