// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The instant the dependency-freshness checks judge release age against.
//
// A pull request is judged as of its head commit's time, so the set of releases
// it must adopt is fixed by the commit: a release that turns a day old while CI
// is still running cannot fail a commit that was current when it was made.
// Every other run (main, schedules, a developer's machine) is judged as of now,
// so drift still surfaces on main the moment it exists.
//
// CHECK_DEPS_AS_OF is an ISO 8601 instant; unset means now.

export function depsReferenceTime() {
  const asOf = process.env.CHECK_DEPS_AS_OF;
  if (asOf === undefined || asOf === "") {
    return Date.now();
  }
  const instant = Date.parse(asOf);
  if (Number.isNaN(instant)) {
    console.error(`::error::CHECK_DEPS_AS_OF is not an ISO 8601 instant: "${asOf}".`);
    process.exit(1);
  }
  if (instant > Date.now()) {
    console.error(`::error::CHECK_DEPS_AS_OF ${asOf} is in the future.`);
    process.exit(1);
  }
  return instant;
}
