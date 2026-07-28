import { copyFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const webDir = resolve(root, "www");

mkdirSync(webDir, { recursive: true });
copyFileSync(resolve(root, "index.html"), resolve(webDir, "index.html"));

console.log("Copied index.html to www/index.html");
