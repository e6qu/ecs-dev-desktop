// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { chooseEnabledImage } from "./deployed-workspace-smoke-lib";

describe("chooseEnabledImage", () => {
  it("selects the enabled image with the expected release tag", () => {
    expect(
      chooseEnabledImage(
        [
          "729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:oldtag",
          "729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:5d46f4b63d6d",
        ],
        "5d46f4b63d6d",
      ),
    ).toBe("729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:5d46f4b63d6d");
  });

  it("fails loudly instead of selecting a stale image when the expected tag is absent", () => {
    expect(() =>
      chooseEnabledImage(
        ["729079515331.dkr.ecr.eu-west-1.amazonaws.com/edd-prod/golden/omnibus:e6b87475c1df"],
        "5d46f4b63d6d",
      ),
    ).toThrow(/no enabled base image with expected tag 5d46f4b63d6d/);
  });
});
