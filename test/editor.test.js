// ============================================================
// EDITOR TEST — the built page, end to end, in Chromium at iPad size
// ============================================================
//
// Drives dist/elemental-editor.html (npm run build first) with touch events,
// framed the way claude.ai frames a page, against an in-memory stand-in for
// the page's database. Checks: boot, library, add, drag, turn, inspector,
// undo/redo, rename (with references), wires, story, prefab break-apart,
// the game's own validator, Play (the real game, in the page) and Stop,
// Save for Claude, the scene list, reload from the device copy, and a
// phone-width layout.
//
// usage: npm run build && npm test
// ============================================================
import fs from 'fs';
import path from 'path';
import http from 'http';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'test/shots');
const PAGE = path.join(ROOT, 'dist/elemental-editor.html');
if (!fs.existsSync(PAGE)) { console.error('Build first: npm run build'); process.exit(1); }
fs.mkdirSync(SHOTS, { recursive: true });

// The page as claude.ai serves it: wrapped in its skeleton.
const wrapped = '<!doctype html><html><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<style>[hidden]{display:none!important}</style></head><body>' + fs.readFileSync(PAGE, 'utf8') + '</body></html>';
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(wrapped); }).listen(0);
const URL = `http://127.0.0.1:${server.address().port}/`;

// A stand-in for the `db` capability: documents in memory, kept across reloads.
const FAKE_DB = () => {
    const store = window.__fakeStore = JSON.parse(sessionStorage.getItem('fakeStore') || '{}');
    const persist = () => sessionStorage.setItem('fakeStore', JSON.stringify(store));
    const snap = (p) => ({ id: p.split('/').pop(), exists: p in store, data: () => store[p] && JSON.parse(JSON.stringify(store[p])) });
    const docRef = p => ({ id: p.split('/').pop(), path: p, get: async () => snap(p), set: async d => { store[p] = JSON.parse(JSON.stringify(d)); persist(); }, delete: async () => { delete store[p]; persist(); }, collection: c => colRef(p + '/' + c) });
    const colRef = (c, order = null, lim = 1000) => ({
        path: c, doc: id => docRef(c + '/' + (id || Math.random().toString(36).slice(2))),
        orderBy: (f, dir = 'asc') => colRef(c, { f, dir }, lim), limit: n => colRef(c, order, n),
        get: async () => {
            let ks = Object.keys(store).filter(k => k.startsWith(c + '/') && k.slice(c.length + 1).split('/').length === 1);
            let docs = ks.map(snap);
            if (order) docs.sort((a, b) => (a.data()[order.f] > b.data()[order.f] ? 1 : -1) * (order.dir === 'desc' ? -1 : 1));
            docs = docs.slice(0, lim);
            return { docs, size: docs.length, empty: !docs.length };
        },
    });
    const db = { doc: docRef, collection: c => colRef(c) };
    window.claude = { use: async name => (name === 'db' ? db : null) };
};

const pass = [], fail = [];
const check = (ok, msg) => (ok ? pass : fail).push(msg);

const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined),
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--mute-audio'],
});
const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, hasTouch: true, deviceScaleFactor: 1 });
await ctx.addInitScript(FAKE_DB);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/fonts\.g|ERR_CERT|Failed to load resource/.test(m.text())) errors.push(m.text()); });
const wait = ms => page.waitForTimeout(ms);
const shot = n => page.screenshot({ path: path.join(SHOTS, n + '.png') });
const ev = (fn, arg) => page.evaluate(fn, arg);

// Touch helpers (in-page, so timing is the page's own).
const helpers = () => ev(() => {
    const cv = document.getElementById('view');
    window.__t = (type, id, x, y) => cv.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, button: 0, isPrimary: true }));
    window.__drag = async (id, a, b, steps = 8) => {
        __t('pointerdown', id, a.x, a.y);
        for (let i = 1; i <= steps; i++) { __t('pointermove', id, a.x + (b.x - a.x) * i / steps, a.y + (b.y - a.y) * i / steps); await new Promise(r => setTimeout(r, 16)); }
        __t('pointerup', id, b.x, b.y);
    };
    window.__at = (x, y, z) => { const V = __ED.view.handle.position.constructor; return __ED.view._screen(new V(x, y, z)); };
});

// ---- 1. boot -------------------------------------------------------------------------------------
await page.goto(URL);
await page.waitForFunction(() => window.__ED?.doc?.scene, null, { timeout: 30000 });
await helpers();
await wait(1500);
const boot = await ev(() => ({ id: __ED.doc.scene.id, n: __ED.doc.scene.objects.length, drawn: __ED.view.models.size, scenes: Object.keys(__ED.GAME_SCENES) }));
check(boot.id === 'lesson1' && boot.drawn === boot.n && boot.n === 38, `opens on Lesson I, every object drawn with the game's models (${JSON.stringify(boot)})`);
check(['courtyard', 'lesson1', 'village'].every(s => boot.scenes.includes(s)), `carries the game's scenes (${boot.scenes.join(', ')})`);
await wait(1200);
const lib = await ev(() => { const c = [...document.querySelectorAll('.lcard')]; return { n: c.length, pics: c.filter(x => x.querySelector('.thumb').style.backgroundImage).length }; });
check(lib.n >= 30 && lib.pics === lib.n, `the library shows every type with a picture (${lib.pics}/${lib.n})`);
await wait(500);
const clean = await ev(() => __ED.validate().filter(p => p.level === 'error').length);
check(clean === 0, `Lesson I passes the game's own checks in the editor (${clean} errors)`);
await shot('E1-lesson');

// ---- 2. add, drag, turn ---------------------------------------------------------------------------------
await ev(() => { __ED.view.plan.cx = 0; __ED.view.plan.cz = 0; __ED.view.plan.ppm = 20; __ED.view._cams(); });
await page.click('.lcard[data-key="rock"]');
await wait(400);
const added = await ev(() => { const o = __ED.doc.scene.objects.at(-1); return { id: o.id, type: o.type, sel: __ED.doc.sel, x: o.x, z: o.z, kind: document.querySelector('.ins-head .kind')?.textContent }; });
check(added.type === 'rock' && added.sel === added.id && added.kind === 'Rock', `tapping Rock adds one at the middle of the view, selected, in the inspector (${JSON.stringify(added)})`);
const moved = await ev(async id => {
    const o = __ED.doc.scene.objects.find(o => o.id === id);
    const a = __at(o.x, 0.3, o.z), b = __at(o.x + 3.3, 0.3, o.z + 2.2);
    await __drag(11, a, b);
    await new Promise(r => setTimeout(r, 100));
    return { x: o.x, z: o.z, fieldX: document.getElementById('ins-x')?.value };
}, added.id);
check(Math.abs(moved.x - 3.5) < 0.01 && Math.abs(moved.z - 2) < 0.01, `dragging it moves it across the ground, snapped to half metres (${JSON.stringify(moved)})`);
const turned = await ev(async id => {
    const o = __ED.doc.scene.objects.find(o => o.id === id);
    const hp = __ED.view.handle.position, a = __at(hp.x, hp.y, hp.z);
    const b = __at(o.x + 3, 0.25, o.z);          // pull the handle round to the east
    await __drag(12, a, b);
    return o.rotY;
}, added.id);
check(Math.abs(turned - Math.PI / 2) < 0.01, `the gold handle turns it, in 15° steps (rotY ${turned.toFixed(3)})`);
const panned = await ev(async () => { const b = __ED.view.plan.cx; await __drag(13, { x: 520, y: 700 }, { x: 420, y: 700 }); return __ED.view.plan.cx - b; });
check(panned > 3, `dragging empty ground pans the plan (${panned.toFixed(1)} m)`);

// ---- 3. inspector, undo, redo --------------------------------------------------------------------------
await page.fill('.props .numwrap input', '1.2');
await page.press('.props .numwrap input', 'Enter');
await wait(200);
const radius = await ev(id => __ED.doc.scene.objects.find(o => o.id === id).radius, added.id);
check(radius === 1.2, `the inspector changes its properties (radius ${radius})`);
await page.click('#undo'); await wait(150);
const undone = await ev(id => __ED.doc.scene.objects.find(o => o.id === id).radius, added.id);
await page.click('#redo'); await wait(150);
const redone = await ev(id => __ED.doc.scene.objects.find(o => o.id === id).radius, added.id);
check(undone === 0.5 && redone === 1.2, `undo and redo (${undone} → ${redone})`);

// ---- 4. rename keeps references --------------------------------------------------------------------------
await ev(() => { __ED.doc.sel = null; });
await ev(() => { const o = __ED.doc.scene.objects.find(o => o.id === 'Lesson1_Plate'); __ED.doc.sel = o.id; __ED.changed('selection'); });
await wait(200);
const nameBox = page.locator('.ins-head input.txt');
await nameBox.fill('FirstPlate');
await nameBox.press('Enter');
await wait(400);
const renamed = await ev(() => {
    const s = __ED.doc.scene, st = s.script.steps.find(x => x.id === 'place');
    return { mark: st.mark, cond: JSON.stringify(st.ends[0].when).includes('FirstPlate'), old: JSON.stringify(s).includes('"Lesson1_Plate"'), errs: __ED.validate().filter(p => p.level === 'error').length };
});
check(renamed.mark === 'FirstPlate' && renamed.cond && !renamed.old, `renaming an object renames every reference to it (${JSON.stringify(renamed)})`);

// ---- 5. wires ----------------------------------------------------------------------------------------------
await page.click('[data-tab=logic]');
await wait(200);
const w0 = await ev(() => __ED.doc.scene.wires.length);
await page.click('text=+ Add a wire');
await wait(600);
const w1 = await ev(() => ({ n: __ED.doc.scene.wires.length, errs: __ED.validate().filter(p => p.level === 'error' && p.where.startsWith('wire')).length }));
check(w1.n === w0 + 1 && w1.errs > 0, `a new wire appears, and Check flags its empty inputs (${JSON.stringify(w1)})`);
await ev(() => {
    const sels = [...document.querySelectorAll('#panel-body .card')].at(-1).querySelectorAll('select');
    const set = (s, v) => { s.value = v; s.dispatchEvent(new Event('change')); };
    set(sels[0], 'Lesson1_WeightL');
});
await wait(300);
await ev(() => {
    const sels = [...document.querySelectorAll('#panel-body .card')].at(-1).querySelectorAll('select');
    const set = (s, v) => { s.value = v; s.dispatchEvent(new Event('change')); };
    set(sels[2], 'TestRoom_Barricade_01');
});
await wait(600);
const wire = await ev(() => ({ w: __ED.doc.scene.wires.at(-1), errs: __ED.validate().filter(p => p.level === 'error').length }));
check(wire.w.inputs[0].obj === 'Lesson1_WeightL' && wire.w.inputs[0].signal === 'weighted' && wire.w.do[0].action === 'raise' && wire.errs === 0,
    `choosing objects fills their signals and actions, and the wire checks clean (${JSON.stringify(wire.w)})`);
await shot('E2-logic');

// ---- 6. story ----------------------------------------------------------------------------------------------
await page.click('[data-tab=story]');
await wait(300);
await page.click('.step-head >> nth=1');
await wait(300);
const story = await ev(() => ({ steps: document.querySelectorAll('.step').length, open: !!document.querySelector('.step.open .step-body'), ends: document.querySelectorAll('.step.open .ending').length }));
check(story.steps === 7 && story.open && story.ends === 1, `the Story tab lists Lesson I's steps; a step opens to its lines and endings (${JSON.stringify(story)})`);
await page.locator('.step.open textarea.lines >> nth=0').fill('That stone.\nLift it, slowly.');
await page.locator('.step.open textarea.lines >> nth=0').dispatchEvent('change');
await wait(200);
const lines = await ev(() => __ED.doc.scene.script.steps[1].say);
check(JSON.stringify(lines) === '["That stone.","Lift it, slowly."]', `step lines are edited as one line per row (${JSON.stringify(lines)})`);
await shot('E3-story');
// A choice on the open step, with a new verb in it: the light changes.
await page.click('.step.open button.add:has-text("choice")');
await wait(300);
await page.locator('.step.open .choice input[placeholder="What the player says"]').fill('Show me.');
await page.locator('.step.open .choice input[placeholder="What the player says"]').dispatchEvent('change');
await page.click('.step.open .choice button.add:has-text("action")');
await wait(300);
await page.locator('.step.open .choice .act .cond-kind select').selectOption('mood');
await wait(300);
const choice = await ev(() => __ED.doc.scene.script.steps[1].choices);
check(choice?.length === 1 && choice[0].label === 'Show me.' && choice[0].do?.[0]?.mood?.name === 'dusk',
    `a step takes choices, and a choice's actions include the new verbs (${JSON.stringify(choice)})`);

// ---- 7. a building, broken apart ------------------------------------------------------------------------------
await page.click('.lcard[data-key="prefab:cottage"]');
await wait(500);
const pre = await ev(() => __ED.doc.scene.objects.length);
await page.click('#panel-body .acts button:has-text("Break apart")');
await wait(700);
const post = await ev(() => ({ n: __ED.doc.scene.objects.length, walls: __ED.doc.scene.objects.filter(o => o.type === 'b_wall').length, roof: __ED.doc.scene.objects.some(o => o.type === 'b_roof') }));
check(post.n === pre - 1 + 6 && post.walls === 4 && post.roof, `a cottage breaks apart into its floor, four walls and roof (${JSON.stringify(post)})`);

// ---- 8. play ---------------------------------------------------------------------------------------------------
await page.click('#play');
await page.waitForFunction(() => window.__EL?.ready, null, { timeout: 30000 }).catch(() => {});
await wait(2500);
const play = await ev(() => ({ on: !!document.getElementById('play-root'), step: __EL?.story?.step, rocks: __EL?.world?.rocks.length, say: document.querySelector('#hud-say .line')?.textContent }));
check(play.on && play.step === 'intro' && play.rocks === 11, `Play starts the real game on this scene: the story runs, the added rock is there (${JSON.stringify(play)})`);
await shot('E4-play');
await page.click('.play-bar .btn.primary');
await wait(800);
const back = await ev(() => ({ gone: !document.getElementById('play-root'), paused: __ED.view.paused, el: window.__EL }));
check(back.gone && !back.paused && !back.el, 'Stop comes back to the editor');
await page.click('#play');
await page.waitForFunction(() => window.__EL?.ready, null, { timeout: 30000 }).catch(() => {});
await wait(1200);
const again = await ev(() => ({ step: __EL?.story?.step, bodies: __EL?.Physics.stats().total }));
await page.click('.play-bar .btn.primary');
check(again.step === 'intro' && again.bodies > 50, `Play works again after Stop (a fresh world: ${again.bodies} bodies)`);

// ---- 9. save for Claude -----------------------------------------------------------------------------------------
await wait(400);
await page.click('#save');
await wait(300);
await page.fill('#save-note', 'Test save: a rock, a wire, a cottage.');
await page.click('.sheet .btn.primary');
await wait(800);
const saved = await ev(() => ({ doc: window.__fakeStore['scenes/lesson1'], versions: Object.keys(window.__fakeStore).filter(k => k.startsWith('scenes/lesson1/versions/')).length, status: document.getElementById('status').textContent }));
check(saved.doc?.scene?.objects?.length > 38 && saved.doc.note.startsWith('Test save') && saved.versions === 1 && /^Saved/.test(saved.status),
    `Save for Claude stores the scene with its note and a version (${saved.doc?.scene?.objects?.length} objects, ${saved.versions} version, “${saved.status}”)`);
fs.writeFileSync(path.join(SHOTS, 'saved-scene.json'), JSON.stringify(saved.doc?.scene, null, 1));

// ---- 10. the scene list, and another scene ---------------------------------------------------------------------------
await page.click('#more');
await wait(700);
const list = await ev(() => [...document.querySelectorAll('.sheet .it b')].map(b => b.textContent));
check(list.includes('Village (building kit sample)') && list.includes('Lesson I · The Quiet Element'), `Scenes lists the game's scenes and the saved one (${list.slice(0, 6).join(' | ')})`);
await page.click('.sheet .it:has-text("Village") button');
await wait(1500);
const village = await ev(() => ({ id: __ED.doc.scene.id, n: __ED.doc.scene.objects.length, drawn: __ED.view.models.size }));
check(village.id === 'village' && village.drawn === village.n, `opens the village (${JSON.stringify(village)})`);
await ev(() => document.querySelector('#mode button[data-mode="3d"]').click());
await wait(800);
await shot('E5-village-3d');

// ---- 11. the device copy ------------------------------------------------------------------------------------------------
await ev(() => { const o = __ED.doc.scene.objects.find(o => o.id === 'Well'); o.x = 1.5; __ED.changed('object:Well'); });
await wait(800);
await page.reload();
await page.waitForFunction(() => window.__ED?.doc?.scene, null, { timeout: 30000 });
await wait(600);
const kept = await ev(() => ({ id: __ED.doc.scene.id, x: __ED.doc.scene.objects.find(o => o.id === 'Well')?.x }));
check(kept.id === 'village' && kept.x === 1.5, `a reload picks up the work from the device (${JSON.stringify(kept)})`);

// ---- 12. phone width ------------------------------------------------------------------------------------------------------
await page.setViewportSize({ width: 390, height: 844 });
await wait(800);
const narrow = await ev(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, canvas: document.getElementById('view').clientWidth }));
await page.click('#panel-toggle');
await wait(400);
await shot('E6-phone');
check(!narrow.overflow && narrow.canvas >= 380, `at phone width the view fills the screen and nothing scrolls sideways (${JSON.stringify(narrow)})`);

// ---- 13. the prologue: buildings, a stone, villagers with jobs, choices and every new verb --------------------------------
await page.setViewportSize({ width: 1180, height: 820 });
await page.click('#more');
await wait(700);
await page.click('.sheet .it:has-text("Prologue") button');
await wait(2500);
await page.click('[data-tab=story]');
await wait(400);
for (let i = 0; i < 14; i++) await page.click(`.step-head >> nth=${i}`);
await wait(600);
const pro = await ev(() => ({ id: __ED.doc.scene.id, drawn: __ED.view.models.size, n: __ED.doc.scene.objects.length, steps: document.querySelectorAll('.step.open').length, choices: document.querySelectorAll('.step.open .choice').length,
    kinds: [...new Set([...document.querySelectorAll('.step.open .cond-kind select')].map(s => s.value))].sort() }));
const wanted = ['many', 'mood', 'npc', 'douseAll', 'setElement', 'hint', 'travel', 'protect', 'flameSpill'];
check(pro.id === 'veyra' && pro.drawn === pro.n && pro.steps === 14 && pro.choices >= 7 && wanted.every(k => pro.kinds.includes(k)),
    `opens the prologue: every object drawn, all 14 steps open with their choices and new verbs editable (${JSON.stringify({ ...pro, kinds: pro.kinds.length })})`);
await shot('E7-prologue-story');

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
server.close();
console.log(pass.map(p => '  ok   ' + p).join('\n'));
if (fail.length) console.log(fail.map(p => '  FAIL ' + p).join('\n'));
if (fail.length) { console.log('EDITOR FAIL'); process.exit(1); }
console.log('EDITOR PASS');
