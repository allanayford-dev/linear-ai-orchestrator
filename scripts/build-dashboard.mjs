import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const outputDirectory = join("dist", "dashboard-public");

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });
await Promise.all([
  cp(join("dashboard", "index.html"), join(outputDirectory, "index.html")),
  cp(join("dashboard", "styles.css"), join(outputDirectory, "styles.css")),
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
  build({
    entryPoints: [join("dashboard", "cost-monitor.ts")],
    outfile: join(outputDirectory, "cost-monitor.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: process.env.NODE_ENV === "production",
    sourcemap: true,
  }),
]);
