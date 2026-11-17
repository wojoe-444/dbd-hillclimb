// Re-acceleration cost for planners (engine README "Acceleration"): a mover that stood still (a medium / slow vault
// landing, a pallet drop or break, the hunter's vault landing with hunter.vaultExitReset) ramps back up at accelMS2.
// The engine integrates per tick: tick k moves min(v, k * accel * dt) * dt. The time lost vs moving at v throughout:
//   lossS = sum_k (v - min(v, k a dt)) dt / v      (survivor 4 m/s at 10 m/s2, dt 0.1: 0.6 m = 0.15 s)
export function accelLossS(v, accel, dt = 0.1) {
  if (!(accel > 0) || accel === Infinity || !(v > 0)) return 0;
  let loss = 0;
  for (let k = 1; k < 1000; k++) { const s = Math.min(v, k * accel * dt); if (s >= v - 1e-12) break; loss += (v - s) * dt; }
  return loss / v;
}

// the costs every planner uses (seconds of lost running): survivor from standing at run speed; hunter from standing at
// base speed; hunter after its own window vault (0 when the engine keeps its speed)
export function accelCosts(cfg) {
  const dt = 1 / (cfg.tickHz || 10), sv = cfg.survivor || {}, hc = cfg.hunter || {};
  const s = accelLossS(sv.runSpeed ?? 4, sv.accelMS2, dt), h = accelLossS(hc.speed ?? 4.6, hc.accelMS2, dt);
  return { sLoss: s, hLoss: h, hVaultLoss: hc.vaultExitReset === false ? 0 : h };
}
