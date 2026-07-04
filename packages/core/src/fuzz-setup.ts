import fc from "fast-check";
// 5000 runs per property — ~10x the default, enough to catch edge cases
// that 100-run fuzzing misses. Keeps CI fast (the tests are pure functions).
fc.configureGlobal({ numRuns: 5000 });
