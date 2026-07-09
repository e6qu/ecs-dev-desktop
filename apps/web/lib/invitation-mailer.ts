// SPDX-License-Identifier: AGPL-3.0-or-later
import { SendEmailCommand, SESv2Client, type SendEmailCommandInput } from "@aws-sdk/client-sesv2";

const EMAIL_FROM_ENV = "EDD_EMAIL_FROM";
const PUBLIC_APP_URL_ENV = "EDD_PUBLIC_APP_URL";
const AWS_REGION_ENV = "AWS_REGION";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

export function assertInvitationMailerConfigured(): void {
  requiredEnv(PUBLIC_APP_URL_ENV);
  requiredEnv(EMAIL_FROM_ENV);
  requiredEnv(AWS_REGION_ENV);
}

export function invitationUrl(token: string): string {
  const base = requiredEnv(PUBLIC_APP_URL_ENV);
  return new URL(`/invitation/${encodeURIComponent(token)}`, base).toString();
}

export function invitationEmail(input: {
  readonly email: string;
  readonly token: string;
}): SendEmailCommandInput {
  const url = invitationUrl(input.token);
  return {
    FromEmailAddress: requiredEnv(EMAIL_FROM_ENV),
    Destination: { ToAddresses: [input.email] },
    Content: {
      Simple: {
        Subject: { Data: "Your EDD workspace invitation", Charset: "UTF-8" },
        Body: {
          Text: {
            Data: `You were invited to EDD as a developer.\n\nAccept the invitation:\n${url}\n`,
            Charset: "UTF-8",
          },
        },
      },
    },
  };
}

export async function sendInvitationEmail(input: {
  readonly email: string;
  readonly token: string;
}): Promise<void> {
  await new SESv2Client({ region: requiredEnv(AWS_REGION_ENV) }).send(
    new SendEmailCommand(invitationEmail(input)),
  );
}
