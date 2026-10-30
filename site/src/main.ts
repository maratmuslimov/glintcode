import "./style.css";
import { codeSvg, detect, detectImage, scanVideo, type Detection, type Format } from "glintcode";
import results from "./results.json";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const NAMES: Record<Format, string> = { capsule: "Glint Capsule", orbit: "Orbit", constellation: "Constellation", halo: "Halo", contour: "Contour" };
const BLURBS: Record<Format, string> = {
  capsule: "A pill with four rows of marks and room for your own text.",
  orbit: "Rings of arcs around a solid lens. A logo fits in the middle.",
  constellation: "The Orbit layout drawn as dots.",
  halo: "52 rays in four lengths, like a sunburst.",
  contour: "Wavy rings like a topographic map. Needs the most pixels.",
};
const ORDER: Format[] = ["capsule", "orbit", "constellation", "halo", "contour"];
const SAMPLE = 20260815;

type Theme = { name: string; bg: string; capsule: object; round: object };
const THEMES: Theme[] = [
  { name: "Ink", bg: "#ffffff", capsule: {}, round: {} },
  { name: "Inverted", bg: "#111216", capsule: { pill: "#ffffff", marks: "#111216" }, round: { ink: "#ffffff", paper: "#111216" } },
  { name: "Indigo", bg: "#ffffff", capsule: { pill: "#3d46e0" }, round: { lens: "#16171c", rings: ["#2f37a8", "#3d46e0", "#5563ee", "#6877ff"] } },
  { name: "Clay", bg: "#f4efe7", capsule: { pill: "#7a2e1d", marks: "#f4efe7" }, round: { ink: "#2b241c", paper: "#f4efe7", lens: "#7a2e1d" } },
];

function render(format: Format, value: number, theme: Theme, text: string) {
  if (format === "capsule") return codeSvg("capsule", value, { ...theme.capsule, label: text || undefined, margin: 0.3 });
  return codeSvg(format, value, { ...theme.round, caption: text || undefined, captionColor: theme.bg === "#111216" ? "#b9bac2" : undefined });
}

/** Draw an SVG on a canvas at the given long side, on a chosen background. */
async function rasterize(svg: string, longSide: number, background?: string) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  const img = new Image();
  img.src = url;
  await img.decode();
  const k = longSide / Math.max(img.naturalWidth || 300, img.naturalHeight || 300);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round((img.naturalWidth || 300) * k);
  canvas.height = Math.round((img.naturalHeight || 300) * k);
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  if (background) {
    g.fillStyle = background;
    g.fillRect(0, 0, canvas.width, canvas.height);
  }
  g.drawImage(img, 0, 0, canvas.width, canvas.height);
  URL.revokeObjectURL(url);
  return canvas;
}

// ---------- generator ----------

const state = { format: "capsule" as Format, theme: THEMES[0], text: "glint.codes", value: SAMPLE };
const output = $("output"), check = $("check");
let renderId = 0;

function randomValue() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return b.reduce((v, x) => v * 256 + x, 0);
}

function segment(host: HTMLElement, items: { label: string; on: () => void; pressed: () => boolean }[]) {
  const sync = () => [...host.children].forEach((b, i) => b.setAttribute("aria-pressed", String(items[i].pressed())));
  host.replaceChildren(
    ...items.map((item) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = item.label;
      b.onclick = () => {
        item.on();
        sync();
        update();
      };
      return b;
    }),
  );
  sync();
  return sync;
}

const syncFormat = segment($("format-seg"), ORDER.map((f) => ({ label: NAMES[f].replace("Glint ", ""), on: () => (state.format = f), pressed: () => state.format === f })));
segment($("theme-seg"), THEMES.map((t) => ({ label: t.name, on: () => (state.theme = t), pressed: () => state.theme === t })));

async function update() {
  const id = ++renderId;
  const { format, value, theme, text } = state;
  const svg = render(format, value, theme, text);
  output.innerHTML = svg;
  output.classList.toggle("round", format !== "capsule");
  $("stage").style.background = theme.bg;
  $("text-label").textContent = format === "capsule" ? "Label inside the capsule" : "Caption under the code";
  const canvas = await rasterize(svg, format === "capsule" ? 1100 : 640, theme.bg);
  if (id !== renderId) return;
  const g = canvas.getContext("2d")!;
  const t0 = performance.now();
  const found = detect({ data: g.getImageData(0, 0, canvas.width, canvas.height).data, width: canvas.width, height: canvas.height });
  const ms = performance.now() - t0;
  const ok = found.some((d) => d.format === format && d.value === value);
  check.className = `check ${ok ? "ok" : "bad"}`;
  check.textContent = ok ? `Read back: ${value.toLocaleString("en-US")} in ${ms.toFixed(0)} ms` : "Couldn't read this one back. Try stronger contrast.";
}

const valueInput = $<HTMLInputElement>("value");
const textInput = $<HTMLInputElement>("text");
valueInput.value = String(state.value);
textInput.value = state.text;
valueInput.oninput = () => {
  const v = Number(valueInput.value.replace(/[\s,_]/g, ""));
  if (!Number.isInteger(v) || v < 0 || v >= 2 ** 48) {
    check.className = "check bad";
    check.textContent = "Enter a whole number from 0 to 281,474,976,710,655.";
    return;
  }
  state.value = v;
  update();
};
textInput.oninput = () => {
  state.text = textInput.value;
  update();
};
$("random").onclick = () => {
  state.value = randomValue();
  valueInput.value = String(state.value);
  update();
};

function save(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const fileName = () => `glint-${state.format}-${state.value}`;
$("save-svg").onclick = () => save(new Blob([render(state.format, state.value, state.theme, state.text)], { type: "image/svg+xml" }), `${fileName()}.svg`);
$("save-png").onclick = async () => {
  const canvas = await rasterize(render(state.format, state.value, state.theme, state.text), 2048, state.theme.bg);
  canvas.toBlob((blob) => blob && save(blob, `${fileName()}.png`), "image/png");
};

// ---------- reader ----------

const video = $<HTMLVideoElement>("video"), overlay = $<HTMLCanvasElement>("overlay"), note = $("reader-note");
let scanner: { stop(): void } | null = null;

function show(d: Detection) {
  $("reading").textContent = d.value.toLocaleString("en-US");
  const rows: [string, string][] = [["Style", NAMES[d.format]], ["Size", `${Math.round(d.size)} px`], ["Bytes corrected", String(d.corrected)]];
  $("reading-meta").replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = k;
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

function stopCamera() {
  scanner?.stop();
  scanner = null;
  (video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
  overlay.getContext("2d")!.clearRect(0, 0, overlay.width, overlay.height);
  $("idle").hidden = false;
  $("stop").hidden = true;
  note.textContent = "";
}

$("camera").onclick = async () => {
  note.textContent = "";
  if (!navigator.mediaDevices?.getUserMedia) {
    note.textContent = "This browser can't reach the camera here. Camera access needs HTTPS.";
    return;
  }
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    await video.play();
  } catch {
    note.textContent = "No camera access. Allow it in the browser's site settings, or read a photo instead.";
    return;
  }
  $("idle").hidden = true;
  $("stop").hidden = false;
  let average = 0;
  scanner = scanVideo(video, {
    onDetect: (d) => {
      show(d);
      navigator.vibrate?.(30);
    },
    onFrame: (found, ms) => {
      average = average ? average * 0.9 + ms * 0.1 : ms;
      note.textContent = `${average.toFixed(0)} ms per frame on this device`;
      overlay.width = video.videoWidth;
      overlay.height = video.videoHeight;
      const g = overlay.getContext("2d")!;
      g.strokeStyle = "#35e08a";
      g.lineWidth = Math.max(3, overlay.width / 300);
      g.lineJoin = "round";
      for (const d of found) {
        g.beginPath();
        d.corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
        g.stroke();
      }
    },
  });
};
$("stop").onclick = stopCamera;

$<HTMLInputElement>("photo").onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const bitmap = await createImageBitmap(file);
  const found = detectImage(bitmap);
  bitmap.close();
  if (found.length) {
    show(found[0]);
    note.textContent = found.length > 1 ? `${found.length} codes in this photo, showing the first.` : "";
  } else {
    $("reading").textContent = "No code found";
    $("reading-meta").replaceChildren();
    note.textContent = "Try a closer, sharper photo.";
  }
};

// ---------- gallery and results ----------

$("hero-code").innerHTML = codeSvg("capsule", SAMPLE, { label: "glint.codes", margin: 0 });

$("gallery").replaceChildren(
  ...ORDER.map((f) => {
    const b = document.createElement("button");
    b.type = "button";
    b.innerHTML = `<div class="face">${f === "capsule" ? codeSvg("capsule", SAMPLE, { margin: 0.1 }) : codeSvg(f, SAMPLE, { margin: 0.08 })}</div><b>${NAMES[f]}</b><span>${BLURBS[f]}</span>`;
    b.onclick = () => {
      state.format = f;
      syncFormat();
      update();
      $("make").scrollIntoView();
    };
    return b;
  }),
);

type Bucket = { n: number; ok: number };
type Row = { format: Format; frames: number; wrong: number; medianMs: number; p90Ms: number; buckets: Record<string, Bucket> };
const rows = results.formats as unknown as Row[];
const rate = (b?: Bucket) => (b ? (100 * b.ok) / b.n : NaN);
const cell = (v: number, low = 60) => `<td class="${v < low ? "low" : ""}">${Number.isNaN(v) ? "n/a" : `${v.toFixed(1)}%`}</td>`;

const total = rows.reduce((s, r) => s + r.frames, 0);
const wrong = rows.reduce((s, r) => s + r.wrong, 0);
const negatives = results.negatives!;
const clean = (results as unknown as { clean: { format: Format; frames: number; read: number; wrong: number }[] }).clean;
const cleanOf = (f: Format) => clean.find((c) => c.format === f)!;
const allFrames = total + negatives.frames + clean.reduce((s, c) => s + c.frames, 0);
const allWrong = wrong + negatives.falseReads + clean.reduce((s, c) => s + c.wrong, 0);
$("tests-title").textContent = `${allFrames.toLocaleString("en-US")} frames, ${allWrong} wrong ${allWrong === 1 ? "read" : "reads"}.`;
$("tests-intro").textContent = "Misses are common on the hardest frames, and the table shows them. The reader is built to miss rather than guess: error correction keeps a byte in reserve to reject bad reads.";
$<HTMLTableElement>("results").innerHTML =
  `<thead><tr><th>Style</th><th>Clean render</th><th>All frames</th><th>Tilt under 20°</th><th>Tilt 45–55°</th><th>Smallest size</th><th>Wrong reads</th><th>Median time</th><th>Slowest 10% from</th></tr></thead><tbody>` +
  ORDER.map((f) => rows.find((r) => r.format === f)!)
    .map((r) => {
      const small = r.buckets["height 22-31px"] ?? r.buckets["size 40-59px"];
      const c = cleanOf(r.format);
      return `<tr><td>${NAMES[r.format]}</td>${cell((100 * c.read) / c.frames, 100)}${cell(rate(r.buckets.all))}${cell(rate(r.buckets["tilt 0-19°"]))}${cell(rate(r.buckets["tilt 45-55°"]))}<td class="${rate(small) < 60 ? "low" : ""}">${rate(small).toFixed(1)}% <small>of ${small.n}</small></td><td>${r.wrong}</td><td>${r.medianMs} ms</td><td>${r.p90Ms} ms</td></tr>`;
    })
    .join("") +
  `</tbody>`;
$("tests-method").innerHTML = [
  `${rows[0].frames} frames per style at ${results.width}×${results.height}, each read once with all five styles enabled. Seed ${results.seed}.`,
  "Chromium draws the real SVG with 3D tilt up to 55°, blur, JPEG compression, sensor-like noise, uneven light and clutter around it.",
  `${negatives.frames} more frames have no code at all, to count false reads: ${negatives.falseReads}.`,
  `Clean render means ${clean[0].frames} perfect renders per style, in four colour schemes, from 320 to 1280 px, including codes that fill the frame.`,
  "Smallest size means a Capsule 22–31 px tall, or a round code 40–59 px wide. Damaged frames cover round codes from 40 to 640 px. Times are for one Apple Silicon core in Node, with both polarities read per frame. Live scanning reads one polarity per frame. Frames that are hard to read cost the most, especially with Halo and Contour.",
]
  .map((t) => `<li>${t}</li>`)
  .join("");

update();
