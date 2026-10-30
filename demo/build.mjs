// Builds the self-contained demo page: the template with the IIFE bundle and stress results inlined.
//   node demo/build.mjs <stress-output.txt> <out.html>
import { readFileSync, writeFileSync } from "node:fs";

const [dir, out] = process.argv.slice(2);
const here = new URL(".", import.meta.url);
const template = readFileSync(new URL("template.html", here), "utf8");
const bundle = readFileSync(new URL("../dist/capsule.iife.js", here), "utf8");

// One summary row per format from `pnpm stress` outputs saved as <dir>/final-<format>.txt.
const SMALL = { capsule: ["height 22-31px", "капсула 22–31 px"], other: ["size 40-59px", "диаметр 40–59 px"] };
const formats = [];
let frames = 0;
let wrongTotal = 0;
for (const format of ["capsule", "orbit", "constellation", "halo", "contour"]) {
  const text = readFileSync(`${dir}/final-${format}.txt`, "utf8");
  const rate = (key) => {
    const m = text.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+\\d+/\\d+\\s+([\\d.]+)%`, "m"));
    return m ? +m[1] : 0;
  };
  const [smallKey, smallLabel] = format === "capsule" ? SMALL.capsule : SMALL.other;
  const n = +text.match(/(\d+) frames/)[1];
  const wrong = +text.match(/wrong payloads\s+(\d+)/)[1];
  frames += n;
  wrongTotal += wrong;
  formats.push({
    format,
    all: rate("all"),
    frontal: rate("tilt 0-19°"),
    steep: rate("tilt 45-55°"),
    small: rate(smallKey),
    smallLabel,
    wrong,
    median: +text.match(/median ([\d.]+) ms/)[1],
  });
}

const html = template
  .replace("/*CAPSULE*/", () => bundle)
  .replace("/*STRESS*/", JSON.stringify({ formats }))
  .replace("__STRESS_TITLE__", `${frames} кадров, ${wrongTotal} неверных чтений`)
  .replace(
    "__STRESS_NOTE__",
    "Кадр 960×720, все пять стилей и обе полярности за один проход. Время указано в JavaScript на одном ядре сервера. Contour мерит сдвиг линии на доли её толщины, поэтому ему нужен примерно вдвое больший размер и он хуже переносит наклон.",
  );
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
