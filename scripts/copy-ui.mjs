import { mkdirSync, copyFileSync } from "node:fs";
mkdirSync("dist/ui", { recursive: true });
copyFileSync("src/ui/index.html", "dist/ui/index.html");
