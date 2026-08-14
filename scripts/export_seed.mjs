import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, "..");
const source = fs.readFileSync(path.join(root, "data.js"), "utf8");
const context = { window: {} };
vm.runInNewContext(source, context, { filename: "data.js" });

if (!context.window.GY_DATA) {
  throw new Error("data.js did not define window.GY_DATA");
}

fs.writeFileSync(
  path.join(root, "seed.json"),
  `${JSON.stringify(context.window.GY_DATA, null, 2)}\n`,
  "utf8"
);
