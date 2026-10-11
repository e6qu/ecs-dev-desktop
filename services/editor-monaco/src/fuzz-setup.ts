import fc from "fast-check";

// Duration-based high-volume fuzz testing: each property runs for up to 15 seconds,
// generating as many random inputs as the CPU can produce (~150K-500K iterations
// for pure functions). This is real fuzzing — not token test runs. Reaching the time
// limit ends the run as a success; only a counterexample fails it.
fc.configureGlobal({ numRuns: 10_000_000 });
fc.installGlobalPlugin(fc.interruptAfterTimeLimit(15_000));
