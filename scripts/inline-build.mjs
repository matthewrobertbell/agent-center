import { readFile, rm, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

const distDirectory = new URL("../dist/", import.meta.url);
const assetsDirectory = new URL("./assets/", distDirectory);
const htmlPath = new URL("./index.html", distDirectory);

let html = await readFile(htmlPath, "utf8");
const scriptMatch = html.match(/<script type="module" crossorigin src="\/assets\/([^"]+)"><\/script>/);
const styleMatch = html.match(/<link rel="stylesheet" crossorigin href="\/assets\/([^"]+)">/);

if (!scriptMatch || !styleMatch) {
  throw new Error("The Vite output did not contain the expected script and stylesheet.");
}

const javascript = await readFile(new URL(`./${scriptMatch[1]}`, assetsDirectory), "utf8");
let css = await readFile(new URL(`./${styleMatch[1]}`, assetsDirectory), "utf8");

const fontReferences = [
  ...css.matchAll(/url\((?:\.\/|\/assets\/)([^\)?]+\.(?:woff2?|ttf))(?:\?[^\)]*)?\)/g),
];
for (const reference of fontReferences) {
  const filename = reference[1];
  const font = await readFile(new URL(`./${filename}`, assetsDirectory));
  const extension = extname(filename).slice(1);
  const mime = extension === "woff2" ? "font/woff2" : extension === "woff" ? "font/woff" : "font/ttf";
  css = css.replaceAll(reference[0], `url(data:${mime};base64,${font.toString("base64")})`);
}

html = html
  .replace(
    scriptMatch[0],
    () => `<script type="module">${javascript.replaceAll("</script", "<\\/script")}</script>`,
  )
  .replace(styleMatch[0], () => `<style>${css.replaceAll("</style", "<\\/style")}</style>`);

await writeFile(htmlPath, html);
await rm(assetsDirectory, { recursive: true, force: true });

const outputPath = join(distDirectory.pathname, "index.html");
console.log(`Created self-contained ${outputPath}`);
