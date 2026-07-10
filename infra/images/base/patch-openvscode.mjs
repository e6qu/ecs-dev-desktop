// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync, writeFileSync } from "node:fs";

const serverMain = "/opt/openvscode-server/out/server-main.js";
const source = readFileSync(serverMain, "utf8");
const needle = "productConfiguration:x,callbackRoute:g";
const replacement =
  'productConfiguration:x,configurationDefaults:{"window.menuBarVisibility":"visible","window.titleBarStyle":"custom","window.commandCenter":false,"window.layoutControl.enabled":false},callbackRoute:g';
const occurrences = source.split(needle).length - 1;
if (occurrences !== 1) {
  throw new Error(
    `OpenVSCode bootstrap patch expected exactly one match in ${serverMain}, found ${String(occurrences)}`,
  );
}
writeFileSync(serverMain, source.replace(needle, replacement));
