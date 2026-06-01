// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ReactNode } from "react";

export const metadata = {
  title: "ecs-dev-desktop",
  description: "Cloud dev-environment control plane",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
