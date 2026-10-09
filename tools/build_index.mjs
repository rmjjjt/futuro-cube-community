// Check every script in scripts/ and rebuild index.json and previews.json.
//   node tools/build_index.mjs           rebuild (run by the GitHub Action on main)
//   node tools/build_index.mjs --check   only check, fail on errors (run on pull requests)
// Each script must compile with the cube's settings and run in the simulator. Its card in
// the Suite's gallery takes @title, @author and @about lines from the first comment,
// falling back to the file name and the comment's first paragraph.
// tools/vendor holds the Suite's compiler and simulator (synced from rmjjjt/futuro_cube).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import createPawncc from "./vendor/lib/pawncc.mjs";
import { CubeSim, ledCss } from "./vendor/js/sim.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, "tools", "vendor", "lib");
const check = process.argv.includes("--check");
const include = fs.readFileSync(path.join(vendor, "futurocube.inc"), "utf8").replaceAll("RegisterVariable(var[])", "RegisterVariable(v[])");
const wasmBinary = fs.readFileSync(path.join(vendor, "pawncc.wasm"));

async function compile(source, name) {
  let log = "";
  const cc = await createPawncc({ wasmBinary, print: (s) => (log += s + "\n"), printErr: (s) => (log += s + "\n") });
  cc.FS.mkdir("/w");
  cc.FS.writeFile("/w/futurocube.inc", include);
  cc.FS.writeFile("/w/empty.inc", "");
  cc.FS.writeFile(`/w/${name}.p`, source);
  cc.FS.chdir("/w");
  let rc;
  try { rc = cc.callMain([`${name}.p`, "-i/w", "-p/w/empty.inc", "-S512", "-d1", "-O3", `-o/w/${name}.amx`]); }
  catch (e) { rc = e?.status ?? 1; }
  let amx = null;
  try { amx = cc.FS.readFile(`/w/${name}.amx`); } catch {}
  return { ok: rc === 0 && !!amx && !/\b(error|fatal error)\s+\d+:/.test(log), amx, log: log.trim() };
}

function meta(name, source) {
  const comment = source.match(/^\s*\/\*([\s\S]*?)\*\//)?.[1] ?? "";
  const tag = (t) => comment.match(new RegExp(`^\\s*@${t}\\s+(.+)$`, "m"))?.[1].trim();
  const para = [];
  for (const raw of comment.split("\n")) {
    const line = raw.trim();
    if (!line) { if (para.length) break; continue; }
    if (line.startsWith("@") || line.endsWith(".p")) continue;
    para.push(line);
  }
  return {
    name,
    title: tag("title") ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
    author: tag("author") ?? "",
    about: (tag("about") ?? para.join(" ")).slice(0, 400),
    path: `scripts/${name}.p`,
  };
}

// a few seconds of the script with scripted tilts and taps, as screen colours
async function preview(amx) {
  const sim = new CubeSim();
  sim.addEventListener("score", () => { sim.tap(4); sim.tap(4); });
  await sim.load(amx);
  sim.start();
  const frames = [], FPS = 12, hex = (c) => ledCss(c).match(/\d+/g).map((x) => Math.round(x / 17).toString(16)).join("");
  for (let t = 0; t < 7500 && sim.running; t += 1000 / FPS) {
    const a = t / 1400, up = [Math.sin(a) * 0.45, 1, Math.cos(a * 0.8) * 0.35], l = Math.hypot(...up);
    sim.setUp(up.map((x) => x / l));
    if (Math.floor(t / 900) !== Math.floor((t - 1000 / FPS) / 900)) sim.tap([0, 3, 4, 2, 1, 4][Math.floor(t / 900) % 6]);
    if (Math.floor(t / 2000) !== Math.floor((t - 1000 / FPS) / 2000)) sim.shake();
    sim.advance(1000 / FPS);
    if (t >= 1500) frames.push(Array.from(sim.leds, hex).join(""));
  }
  return { frames, error: sim.running || frames.length ? null : "the script stopped straight away in the simulator" };
}

const problems = [], scripts = [], previews = {};
const files = fs.readdirSync(path.join(root, "scripts")).filter((f) => !f.startsWith(".")).sort();
for (const file of files) {
  const name = file.replace(/\.p$/, "");
  const full = path.join(root, "scripts", file);
  if (!file.endsWith(".p")) { problems.push(`${file}: only .p files go in scripts/`); continue; }
  if (!/^[A-Za-z][A-Za-z0-9_]{0,29}$/.test(name)) { problems.push(`${file}: name it with letters, digits and _ (max 30, starting with a letter)`); continue; }
  if (fs.statSync(full).size > 64 * 1024) { problems.push(`${file}: too big (max 64 KB)`); continue; }
  const source = fs.readFileSync(full, "utf8");
  const res = await compile(source, name);
  if (!res.ok) { problems.push(`${file}: doesn't compile\n${res.log}`); continue; }
  const p = await preview(res.amx);
  if (p.error) { problems.push(`${file}: ${p.error}`); continue; }
  scripts.push(meta(name, source));
  previews[name] = p.frames;
  console.log(`ok  ${file} (${res.amx.length} bytes)`);
}
// featured.json: names the maintainer picks to show first, in that order
let featured = [];
try { featured = JSON.parse(fs.readFileSync(path.join(root, "featured.json"), "utf8")).featured ?? []; }
catch (e) { if (e.code !== "ENOENT") problems.push(`featured.json: ${e.message}`); }
for (const f of featured) if (!scripts.some((s) => s.name === f)) console.warn(`warn featured.json names "${f}", which isn't in scripts/`);
for (const s of scripts) if (featured.includes(s.name)) s.featured = true;
const rank = (s) => (s.featured ? featured.indexOf(s.name) : featured.length);
scripts.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
for (const p of problems) console.error(`ERR ${p}`);
if (!check) {
  fs.writeFileSync(path.join(root, "index.json"), JSON.stringify({ scripts }, null, 1) + "\n");
  fs.writeFileSync(path.join(root, "previews.json"), JSON.stringify(previews));
  console.log(`index.json: ${scripts.length} scripts`);
}
process.exit(problems.length ? 1 : 0);
