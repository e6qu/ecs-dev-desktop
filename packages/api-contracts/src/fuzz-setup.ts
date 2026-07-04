import fc from "fast-check";

// Duration-based high-volume fuzzing: each property runs for up to 3 seconds,
// generating as many random inputs as the CPU can produce (~30K-100K iterations
// for pure functions). This is 10-100x more thorough than fixed-count fuzzing.
// numRuns is set high as a safety cap; the time limit is the real bound.
fc.configureGlobal({
  numRuns: 1_000_000,
  interruptAfterTimeLimit: 3_000,
  markInterruptAsFailure: false,
});
