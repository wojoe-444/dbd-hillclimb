// Brain helper: walk to a free generator side slot and repair from it. Pure factory -- all state lives in the closure
// returned per brain instance (solo-queue rule: no module-level mutable state, nothing shared between instances).
//
//   const slots = makeSlotPicker();            // once per brain instance (inside the brain factory)
//   return slots.act(obs, gi, obs.gens[gi], { walk, hold });   // -> action ({moveTo} / {act:'repair'} / {})
//   (survivors: pass obs.gens[gi] of a found gen — it carries id + slots; ctx.map.generators is hunter-only)
//
// Engine rule (README): repair needs the survivor within reach.repairSlot (0.6 m) of a slot point that no other survivor
// is repairing from. Slot choice: keep the current slot; else the nearest one not taken and not recently failed. Taken =
// in obs.gens[gi].slotsTaken (someone repairs there; only when the gen is perceived) or a visible standing teammate
// within 0.9 m of the slot point (about to repair there / standing on it). A slot is marked failed when repair doesn't
// start within ~1 s of standing on it, or when we stop getting closer to it for ~0.8 s (body-blocked). When every slot
// has failed, the list resets.

const hyp = (a, b) => Math.sqrt(a * a + b * b);

export function makeSlotPicker(reach = 0.6) {
  let gen = -1, side = null, atT = -1, bestD = Infinity, bestT = 0;
  let failed = [];
  const within = reach - 0.05;

  const occupied = (obs, s) => (obs.teammates || []).some(t => (t.state === 'healthy' || t.state === 'injured') && hyp(t.x - s.x, t.z - s.z) < 0.9);

  function pick(obs, gi, g, me) {
    const taken = obs.gens[gi].slotsTaken;   // null when the gen isn't perceived
    let best = null, bd = Infinity;
    for (let pass = 0; pass < 3 && !best; pass++) {
      for (const s of g.slots) {
        if (pass < 2 && failed.includes(s.side)) continue;
        if (pass < 1 && ((taken && taken.includes(s.side)) || occupied(obs, s))) continue;
        const d = hyp(s.x - me.x, s.z - me.z);
        if (d < bd) { bd = d; best = s; }
      }
      if (!best && pass === 0) failed = [];
    }
    side = best ? best.side : null; atT = -1; bestD = Infinity; bestT = obs.t;
    return best;
  }

  return {
    reset() { gen = -1; side = null; failed = []; },
    act(obs, gi, g, opt = {}) {
      const me = obs.self;
      if (!g.slots || !g.slots.length) return {};
      if (gi !== gen) { gen = gi; side = null; failed = []; }
      let s = side ? g.slots.find(x => x.side === side) : null;
      const repairing = me.act === 'repair';
      // our slot became known-taken by someone else (and we're not the one repairing there): re-pick
      if (s && !repairing && hyp(s.x - me.x, s.z - me.z) > within && ((obs.gens[gi].slotsTaken && obs.gens[gi].slotsTaken.includes(s.side)) || occupied(obs, s))) { failed.push(s.side); s = null; }
      if (!s) s = pick(obs, gi, g, me);
      if (!s) return {};
      const d = hyp(s.x - me.x, s.z - me.z);
      if (d <= within) {
        if (opt.hold) return {};
        if (repairing) atT = -1;
        else if (atT < 0) atT = obs.t;
        else if (obs.t - atT > 1) { failed.push(s.side); side = null; return { act: 'repair', target: g.id }; }
        return { act: 'repair', target: g.id };
      }
      if (d > 2.5) { bestD = Infinity; bestT = obs.t; }   // still en route (paths may curve away): no stall check
      else if (d < bestD - 0.1) { bestD = d; bestT = obs.t; }
      else if (obs.t - bestT > 0.8) { failed.push(s.side); side = null; }
      return { moveTo: { x: s.x, z: s.z }, walk: !!opt.walk };
    },
  };
}
