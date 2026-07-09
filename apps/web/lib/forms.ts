// SPDX-License-Identifier: AGPL-3.0-or-later

export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
