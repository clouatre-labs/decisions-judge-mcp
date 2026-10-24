// Image accuracy probe for issue #95: generates synthetic ground-truth PNGs
// (solid square on white background), then asks one `box` question (scored by
// IoU against ground truth) and one `noul` question (scored as correct when
// probability >= 0.5 for the unambiguous yes) in a single request per image.
// Runs offline except for the API calls. Requires TYPESAFE_API_KEY in env.
// This probe bypasses the server's validateImages guard on purpose: it talks
// to the SDK directly to measure raw model accuracy for image-backed noul,
// which the judge contract currently does not accept.
//
// Usage: node scripts/probe-images.mjs [--model jev-1.14.0]
import { TypeSafeClient, box, image, noul } from "@typesafe-ai/sdk";
import { deflateSync } from "node:zlib";

const MODEL = process.argv.includes("--model")
  ? process.argv[process.argv.indexOf("--model") + 1]
  : "jev-1.14.0";
const SIZE = 512;

// CRC32 for PNG chunks.
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Encode a 512x512 RGB PNG. pixels(x, y) returns [r, g, b].
function encodePng(pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor RGB
  const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
  for (let y = 0; y < SIZE; y++) {
    const row = y * (SIZE * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < SIZE; x++) {
      const [r, g, b] = pixels(x, y);
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 10 synthetic images with varied position, size, and color. Fractions are
// exact: [left, right) x [top, bottom) as multiples of SIZE.
const CASES = [
  { color: [255, 0, 0], name: "red", left: 96, top: 128, size: [128, 192] },
  { color: [0, 160, 0], name: "green", left: 256, top: 64, size: [192, 128] },
  { color: [0, 0, 255], name: "blue", left: 32, top: 320, size: [160, 160] },
  { color: [255, 160, 0], name: "orange", left: 320, top: 288, size: [128, 160] },
  { color: [128, 0, 128], name: "purple", left: 128, top: 32, size: [256, 64] },
  { color: [0, 200, 200], name: "cyan", left: 384, top: 128, size: [96, 256] },
  { color: [200, 0, 100], name: "magenta", left: 16, top: 16, size: [64, 64] },
  { color: [100, 100, 0], name: "olive", left: 224, top: 224, size: [256, 256] },
  { color: [255, 128, 128], name: "pink", left: 48, top: 200, size: [320, 96] },
  { color: [0, 0, 128], name: "navy", left: 300, top: 400, size: [180, 80] },
].map((c) => ({
  ...c,
  right: Math.min(c.left + c.size[0], SIZE),
  bottom: Math.min(c.top + c.size[1], SIZE),
}));

function iou(a, b) {
  const inter =
    Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) *
    Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const area = (r) => (r.right - r.left) * (r.bottom - r.top);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

function frac(px) {
  return px / SIZE;
}

const client = new TypeSafeClient();
const results = [];
for (const c of CASES) {
  const png = encodePng((x, y) =>
    x >= c.left && x < c.right && y >= c.top && y < c.bottom ? c.color : [255, 255, 255],
  );
  const truth = { top: frac(c.top), bottom: frac(c.bottom), left: frac(c.left), right: frac(c.right) };
  try {
    const { answers, usage } = await client.systemOne(
      {
        state: image(png),
        questions: {
          locate: box(`The ${c.name} square`),
          is_present: noul(`Is there a ${c.name} square in the image?`),
        },
        model: MODEL,
      },
      { headers: { "TypeSafe-Danger-Zone-Images": "true" }, timeout: 60_000 },
    );
    const got = answers.locate.box;
    const score = iou(truth, got);
    const noulP = answers.is_present.noul;
    results.push({
      case: c.name,
      truth,
      box: got,
      iou: Number(score.toFixed(3)),
      noul: noulP,
      noul_correct: noulP >= 0.5,
      confidence: answers.locate.confidence,
      usage,
    });
    console.error(
      `${c.name}: IoU=${score.toFixed(3)} noul=${noulP.toFixed(3)} ` +
        `(in=${usage?.prompt_tokens} out=${usage?.completion_tokens})`,
    );
  } catch (err) {
    results.push({ case: c.name, error: String(err) });
    console.error(`${c.name}: ERROR ${String(err)}`);
  }
}

const boxes = results.filter((r) => typeof r.iou === "number");
const noulCases = results.filter((r) => typeof r.noul === "number");
const summary = {
  model: MODEL,
  images: CASES.length,
  box_mean_iou: boxes.length ? Number((boxes.reduce((s, r) => s + r.iou, 0) / boxes.length).toFixed(3)) : null,
  box_pass_rubric: boxes.length === CASES.length && boxes.reduce((s, r) => s + r.iou, 0) / boxes.length >= 0.8,
  noul_correct: noulCases.filter((r) => r.noul_correct).length,
  noul_total: noulCases.length,
  noul_pass_rubric: noulCases.length === CASES.length && noulCases.filter((r) => r.noul_correct).length >= 9,
  errors: results.filter((r) => r.error).length,
};
console.log(JSON.stringify({ summary, results }, null, 2));
