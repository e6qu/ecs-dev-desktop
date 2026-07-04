// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";

export function StateBlock({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="empty">
      <h2 className="big">{title}</h2>
      <p>{detail}</p>
      {action !== undefined && (
        <p style={{ marginTop: 18 }}>
          <Link className="btn primary" href={action.href}>
            {action.label}
          </Link>
        </p>
      )}
    </div>
  );
}
