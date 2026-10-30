// Builds the self-contained demo page: the template with the IIFE bundle and stress results inlined.
//   node demo/build.mjs <stress-output.txt> <out.html>
import { readFileSync, writeFileSync } from "node:fs";

const [stressFile, out] = process.argv.slice(2);
const here = new URL(".", import.meta.url);
const template = readFileSync(new URL("template.html", here), "utf8");
const bundle = readFileSync(new URL("../dist/capsule.iife.js", here), "utf8");
const text = readFileSync(stressFile, "utf8");

const LABELS = {
  all: "Все кадры",
  "height 22-31px": "Высота капсулы 22–31 px",
  "height 32-47px": "Высота капсулы 32–47 px",
  "height 48-79px": "Высота капсулы 48–79 px",
  "height 80-160px": "Высота капсулы 80–160 px",
  "tilt 0-19°": "Наклон до 20°",
  "tilt 20-34°": "Наклон 20–34°",
  "tilt 35-44°": "Наклон 35–44°",
  "tilt 45-55°": "Наклон 45–55°",
  "blur none": "Без размытия",
  "blur <0.8px": "Размытие до 0,8 px",
  "blur 0.8-1.6px": "Размытие 0,8–1,6 px",
  "style pill": "Чёрная капсула",
  "style pill+label": "С названием и подписью",
  "style inverted": "Белая капсула на тёмном",
  "style bare": "Без капсулы",
  "style brand": "Цветная капсула",
  "style rows": "Цветные строки",
};
const rows = [];
for (const line of text.split("\n")) {
  const m = line.match(/^(.+?)\s+(\d+)\/(\d+)\s+([\d.]+)%/);
  if (m && LABELS[m[1].trim()]) rows.push({ key: m[1].trim(), label: LABELS[m[1].trim()], n: +m[3], rate: +m[4] });
}
const order = Object.keys(LABELS);
rows.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
const frames = text.match(/(\d+) frames/)?.[1];
const wrong = text.match(/wrong payloads\s+(\d+)/)?.[1];
const time = text.match(/median ([\d.]+) ms, p90 ([\d.]+) ms/);

const html = template
  .replace("/*CAPSULE*/", () => bundle)
  .replace("/*STRESS*/", JSON.stringify({ rows }))
  .replace("__STRESS_TITLE__", `${frames} кадров, ${wrong} неверных чтений`)
  .replace(
    "__STRESS_NOTE__",
    `Кадр 960×720, обе полярности (тёмная и светлая капсула) за один проход: медиана ${Math.round(time[1])} мс, 90% кадров быстрее ${Math.round(time[2])} мс на одном ядре сервера, в JavaScript. Сканер камеры чередует полярности между кадрами, это вдвое меньше работы на кадр. Капсулы ниже 32 px в рабочем кадре на пределе: метка там тоньше 3 пикселей.`,
  );
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
