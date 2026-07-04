import fc from "fast-check";

// Duration-based high-volume fuzz testing: each property runs for up to 15 seconds,
// generating as many random inputs as the CPU can produce (~150K-500K iterations
// for pure functions). This is real fuzzing — not token test runs.
fc.configureGlobal({
  numRuns: 10_000_000,
  interruptAfterTimeLimit: 15_000,
  markInterruptAsFailure: false,
});
