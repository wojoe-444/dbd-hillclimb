// Example per-match metric (evolve.js --metrics src/hillclimb/metrics/chase.js): engine chase time.
//   chase.s      seconds with an engine-level chase running
//   chase.share  fraction of the match spent in chase
export default {
  name: 'chase',
  create() {
    let ticks = 0;
    return {
      step(m) { if (m.chaseTgt >= 0) ticks++; },
      finish(m, res) { return { s: +(ticks * m.dt).toFixed(2), share: +(ticks / Math.max(1, res.ticks)).toFixed(4) }; },
    };
  },
};
