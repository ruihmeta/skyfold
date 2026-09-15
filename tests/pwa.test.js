import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("manifest describes an installable standalone portrait app", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.webmanifest"), "utf8"));
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, "portrait-primary");
  assert.ok(manifest.name.includes("Skyfold"));
  assert.ok(manifest.icons.length >= 1);
  for (const icon of manifest.icons) await access(path.join(root, icon.src.replace(/^\.\//, "")));
});

test("HTML references only local runtime assets", async () => {
  const html = await readFile(path.join(root, "index.html"), "utf8");
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /type="module" src="\.\/app\.js"/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test("3D runtime dependencies and queried UI elements are present", async () => {
  const [html, app] = await Promise.all([
    readFile(path.join(root, "index.html"), "utf8"),
    readFile(path.join(root, "app.js"), "utf8")
  ]);
  assert.match(app, /vendor\/three\.module\.min\.js/);
  assert.doesNotMatch(app, /requestJump/);
  assert.match(app, /stepVerticalPhysics/);
  assert.match(app, /requestMotionAccess/);
  assert.match(app, /applyJumpImpulse/);
  const queriedIds = [...app.matchAll(/querySelector\("#([^"]+)"\)/g)].map((match) => match[1]);
  for (const id of queriedIds) assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
});

test("service worker app shell files exist", async () => {
  const worker = await readFile(path.join(root, "sw.js"), "utf8");
  const shellMatch = worker.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  assert.ok(shellMatch);
  const assets = [...shellMatch[1].matchAll(/"\.\/(.*?)"/g)].map((match) => match[1] || "index.html");
  for (const asset of assets) await access(path.join(root, asset));
});
