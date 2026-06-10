// Robot-Islands real-hardware render profiler hotfix.
// Measures per-frame wall-clock time on the user's actual GPU/CPU.
// Three signals captured:
//   1. requestAnimationFrame callback duration (catches the CPU side of
//      the PixiJS render loop + game tick).
//   2. PerformanceObserver longtask entries (>50ms blocks).
//   3. Memory snapshots (if performance.memory is exposed in this Chrome).
//
// Read back via: daedalus.py exec ri-dump 'JSON.stringify(window.__riProfilerDump())'
// Reset: daedalus.py exec ri-reset 'window.__riProfilerReset()'
(function () {
  if (window.__riProfilerLoaded) return;
  window.__riProfilerLoaded = true;

  const frames = [];
  const longTasks = [];
  const memSnapshots = [];
  const t0 = performance.now();

  // ── Hook 1: RAF callback duration ─────────────────────────────────
  const origRAF = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return origRAF(function (t) {
      const start = performance.now();
      try {
        cb(t);
      } finally {
        const end = performance.now();
        frames.push({ start, dur: end - start });
      }
    });
  };

  // ── Hook 2: longtask observer ─────────────────────────────────────
  if (window.PerformanceObserver) {
    try {
      const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          longTasks.push({
            start: e.startTime,
            dur: e.duration,
            name: e.name,
          });
        }
      });
      obs.observe({ entryTypes: ["longtask"] });
    } catch (e) {
      console.warn("[ri-prof] longtask observer failed:", e);
    }
  }

  // ── Hook 3: memory polling every 500 ms ───────────────────────────
  setInterval(() => {
    if (performance.memory) {
      memSnapshots.push({
        t: performance.now() - t0,
        usedJSHeap: performance.memory.usedJSHeapSize,
        totalJSHeap: performance.memory.totalJSHeapSize,
      });
    }
  }, 500);

  // ── Dump / reset API ──────────────────────────────────────────────
  function pctile(arr, p) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
  }

  window.__riProfilerDump = function () {
    const durs = frames.map((f) => f.dur);
    const stats = durs.length
      ? {
          n: durs.length,
          mean: durs.reduce((a, b) => a + b, 0) / durs.length,
          p50: pctile(durs, 0.5),
          p90: pctile(durs, 0.9),
          p99: pctile(durs, 0.99),
          max: Math.max(...durs),
          min: Math.min(...durs),
          // approximate frame rate from inter-frame start deltas
          avgInterval:
            frames.length > 1
              ? (frames[frames.length - 1].start - frames[0].start) /
                (frames.length - 1)
              : null,
        }
      : null;
    return {
      uptimeMs: performance.now() - t0,
      frames: stats,
      longTasks: {
        n: longTasks.length,
        totalMs: longTasks.reduce((a, b) => a + b.dur, 0),
        worst: longTasks.slice().sort((a, b) => b.dur - a.dur).slice(0, 10),
      },
      memory: memSnapshots.length
        ? {
            firstUsedJSHeap: memSnapshots[0].usedJSHeap,
            lastUsedJSHeap: memSnapshots[memSnapshots.length - 1].usedJSHeap,
            samples: memSnapshots.length,
            growthMb:
              (memSnapshots[memSnapshots.length - 1].usedJSHeap -
                memSnapshots[0].usedJSHeap) /
              1024 /
              1024,
          }
        : null,
    };
  };

  window.__riProfilerReset = function () {
    frames.length = 0;
    longTasks.length = 0;
    memSnapshots.length = 0;
  };

  console.log("[ri-prof] loaded — call __riProfilerDump() to read");
})();
