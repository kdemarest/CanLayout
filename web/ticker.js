// The page's clock (Ken, 2026-10-28): anything that animates (the sea, effects in pfx/) adds a
// function, and each frame app.js's loop calls Ticker.tick(dt), which calls every one with dt
// (seconds since the last frame, at most 0.1, like Unity's Time.deltaTime with its maximum) and
// time (the sum of those dts, like Time.time: it stands still while the page is hidden).
//   const stop = Ticker.add((dt, time) => { ... });   stop() removes it.
// A function that throws is dropped (its error shows in the status line), so one bad effect
// can't stop the rest.
(function (root) {
    const listeners = new Set();
    const Ticker = {
        time: 0,
        frame: 0, // ticks so far (it counts on while ☰ Tick is off and dt is 0)
        add(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        tick(dt) {
            Ticker.time += dt;
            Ticker.frame++;
            for (const fn of [...listeners]) {
                try {
                    fn(dt, Ticker.time);
                } catch (error) {
                    listeners.delete(fn);
                    setTimeout(() => { throw error; }); // reported like any page error
                }
            }
        }
    };
    root.Ticker = Ticker;
})(window);
