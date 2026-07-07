// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import {
  imageSourceConfigFromEnv,
  getImageSourceService,
  observationFromGithubPush,
  validateGithubWebhookBody,
  validateGithubWebhookHeaders,
  type GithubPushPayload,
} from "../../../../../lib/image-source";
import { withObservability } from "../../../../../lib/observability";

async function handlePOST(req: Request) {
  const cfg = imageSourceConfigFromEnv();

  const headerRejection = validateGithubWebhookHeaders(req.headers);
  if (headerRejection !== null) {
    return NextResponse.json({ error: headerRejection.error }, { status: headerRejection.status });
  }
  const raw = await req.text();
  const bodyRejection = validateGithubWebhookBody(
    raw,
    req.headers.get("x-hub-signature-256"),
    cfg.webhookSecret,
  );
  if (bodyRejection !== null) {
    return NextResponse.json({ error: bodyRejection.error }, { status: bodyRejection.status });
  }

  let payload: GithubPushPayload;
  try {
    payload = JSON.parse(raw) as GithubPushPayload;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const observation = observationFromGithubPush(payload, cfg.repo, cfg.branch);
  if (observation === null)
    return NextResponse.json({ ignored: true, reason: "wrong repo or branch" });

  const trigger = await getImageSourceService().handleObservation(observation);
  return NextResponse.json({ trigger }, { status: 202 });
}

export const POST = withObservability("integrations.github.image-webhook", handlePOST);
