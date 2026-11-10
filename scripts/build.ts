import { mkdir, copyFile, cp } from "node:fs/promises";
await mkdir("dist", { recursive: true });
const result = await Bun.build({
  entrypoints: ["src/web/app.ts"],
  outdir: "dist",
  naming: "app.js",
  target: "browser",
  minify: true,
});
if (!result.success) {
  console.error(result.logs);
  process.exit(1);
}
await Promise.all(
  ["index.html", "style.css", "favicon.svg"].map((file) =>
    copyFile(`src/web/${file}`, `dist/${file}`),
  ),
);
await mkdir("dist/fonts", { recursive: true });
await copyFile("src/web/fonts/dm-sans.woff2", "dist/fonts/dm-sans.woff2");
if (process.argv.includes("--vercel"))
  await cp("dist", "public", { recursive: true });
console.log(
  `Built BlockOps: ${result.outputs.map((o) => Math.round(o.size / 1024) + " KB").join(", ")} JavaScript.`,
);
