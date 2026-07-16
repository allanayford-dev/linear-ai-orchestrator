import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const outputDirectory = join("dist", "dashboard-public");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  cp(join("dashboard", "index.html"), join(outputDirectory, "index.html")),
  cp(join("dashboard", "styles.css"), join(outputDirectory, "styles.css")),
  cp(join("dashboard", "manifest.webmanifest"), join(outputDirectory, "manifest.webmanifest")),
  cp(join("dashboard", "service-worker.js"), join(outputDirectory, "service-worker.js")),
  cp(join("dashboard", "offline.html"), join(outputDirectory, "offline.html")),
  cp(join("dashboard", "icons"), join(outputDirectory, "icons"), { recursive: true }),
  build({
    entryPoints: [join("dashboard", "client.ts")],
    outfile: join(outputDirectory, "app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: process.env.NODE_ENV === "production",
    sourcemap: true,
  }),
]);
