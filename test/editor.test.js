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
check(boot.id === 'lesson1' && boot.drawn === boot.n && boot.n === 39, `opens on Lesson I, every object drawn with the game's models (${JSON.stringify(boot)})`);
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

// The benchmark: Bench plays the Verdant Reach and walks the fixed path, measuring every frame.
await page.click('#play');
await page.waitForFunction(() => window.__EL?.ready, null, { timeout: 30000 }).catch(() => {});
await page.click('.play-bar button[title^="A fixed"]');
await page.waitForFunction(() => window.__EL?.ready && window.__EL.perf?.onFrame, null, { timeout: 60000 }).catch(() => {});
await wait(1500);
const bench = await ev(() => ({ tag: document.querySelector('.play-tag')?.textContent, running: !!__EL?.perf?.onFrame, cottage: !!__EL?.world?.objects.get('Thornwick_03_cottage')?.structure }));
await page.click('.play-bar .btn.primary');
await wait(600);
const benchGone = await ev(() => !document.getElementById('play-root') && !document.getElementById('bench-card'));
check(/^Benchmark/.test(bench.tag) && bench.running && bench.cottage && benchGone, `Bench runs the benchmark through Thornwick from the play bar, and Stop leaves it (${JSON.stringify(bench)})`);

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
const nSteps = await ev(() => __ED.doc.scene.script.steps.length);
for (let i = 0; i < nSteps; i++) await page.click(`.step-head >> nth=${i}`);
await wait(600);
const pro = await ev(() => ({ id: __ED.doc.scene.id, drawn: __ED.view.models.size, n: __ED.doc.scene.objects.length, steps: document.querySelectorAll('.step.open').length, choices: document.querySelectorAll('.step.open .choice').length,
    kinds: [...new Set([...document.querySelectorAll('.step.open .cond-kind select')].map(s => s.value))].sort() }));
const wanted = ['many', 'mood', 'npc', 'douseAll', 'setElement', 'hint', 'reveal', 'protect', 'flameSpill'];
check(pro.id === 'veyra' && pro.drawn === pro.n && pro.steps === nSteps && nSteps >= 18 && pro.choices >= 10 && wanted.every(k => pro.kinds.includes(k)),
    `opens the prologue: every object drawn, all ${nSteps} steps open with their choices and new verbs editable (${JSON.stringify({ ...pro, kinds: pro.kinds.length })})`);
await shot('E7-prologue-story');

// ---- 14. phase 5: land, several at once, routes ------------------------------------------------------------------------
await helpers();
await page.click('#more');
await wait(700);
await page.click('.sheet .it:has-text("Saltmere Coast") button');
await wait(3000);
const land = await ev(() => {
    const V = __ED.view, o = __ED.doc.scene.objects.find(q => q.id === 'Lanthe_Council'), m = V.models.get('Lanthe_Council');
    return { id: __ED.doc.scene.id, terrain: !!V.terrain, chunks: V.terrain?.chunks.size, drawn: V.models.size, n: __ED.doc.scene.objects.length, seated: +(m.root.position.y - V.groundY(o.x, o.z)).toFixed(2) };
});
check(land.terrain && land.chunks >= 16 && land.drawn === land.n && Math.abs(land.seated) < 0.05, `a region opens on its land, everything standing on the ground (${JSON.stringify(land)})`);
// A raise stroke where nothing stands, then paint, then undo.
await page.click('[data-tab=land]');
await wait(400);
const look = (cx, cz, ppm = 8) => ev(([cx, cz, ppm]) => { Object.assign(__ED.view.plan, { cx, cz, ppm }); __ED.view._cams(); __ED.view.redraw(); }, [cx, cz, ppm]);
await look(-80, -80);
await page.click('.sec .seg button:has-text("Raise")');
await wait(200);
const h0 = await ev(() => __ED.view.groundY(-80, -80));
await ev(async () => { const a = __at(-86, 0, -80), b = __at(-74, 0, -80); await __drag(1, a, b, 10); });
await wait(400);
const raised = await ev(() => ({ h: +__ED.view.groundY(-80, -80).toFixed(2), saved: __ED.view.terrainKey.includes(__ED.doc.scene.settings.terrain.heights), brush: __ED.view.brush?.kind }));
check(raised.h > h0 + 0.4 && raised.saved && raised.brush === 'raise', `the Raise brush builds the land up under a stroke, and it goes into the scene (${h0.toFixed(2)} → ${JSON.stringify(raised)})`);
await page.click('#undo');
await wait(500);
const landBack = await ev(() => +__ED.view.groundY(-80, -80).toFixed(2));
check(Math.abs(landBack - h0) < 0.02, `one undo takes the whole stroke back (${landBack} vs ${h0.toFixed(2)})`);
await page.click('.sec .seg button:has-text("Paint")');
await wait(300);
await page.selectOption('.sec select', 'snow');
await ev(async () => { const a = __at(-84, 0, -80), b = __at(-76, 0, -80); await __drag(1, a, b, 6); });
await wait(400);
const painted = await ev(() => __ED.view.terrain.surface(-80, -80).key);
check(painted === 'snow', `the Paint brush paints the surface (${painted})`);
// Flatten round a house: it stays standing on the ground.
await page.click('.sec .seg button:has-text("Flatten")');
await ev(() => { const o = __ED.doc.scene.objects.find(q => q.id === 'Lanthe_House_1'); Object.assign(__ED.view.plan, { cx: o.x, cz: o.z, ppm: 10 }); __ED.view._cams(); });
const follows = await ev(async () => {
    const o = __ED.doc.scene.objects.find(q => q.id === 'Lanthe_House_1'), V = __ED.view;
    await __drag(1, __at(o.x - 6, 0, o.z + 4), __at(o.x + 6, 0, o.z + 4), 10);
    return +(V.models.get(o.id).root.position.y - V.groundY(o.x, o.z)).toFixed(2);
});
check(Math.abs(follows) < 0.05, `things on the land follow it as it changes (${follows})`);
await shot('E7-land');
// Leaving the Land tab puts the brush down.
await page.click('[data-tab=scene]');
await wait(300);
const moods = await ev(() => [...document.querySelectorAll('#panel-body select')].map(s => [...s.options].map(o => o.value)).find(v => v.includes('ember')) || []);
check(!(await ev(() => !!__ED.view.brush)) && ['day', 'dusk', 'night', 'ember', 'sea', 'peaks', 'glare'].every(m => moods.includes(m)), `the brush is put down outside the Land tab; the Scene tab offers every light (${moods.join(', ')})`);

// The sea under everything: a drag on it pans, a tap selects it.
await look(80, 60, 6);
const sea = await ev(async () => {
    const V = __ED.view, s = __at(80, 1, 60), cx = V.plan.cx;
    await __drag(1, s, { x: s.x + 60, y: s.y }, 6);
    const panned = +(cx - V.plan.cx).toFixed(1), selAfterDrag = __ED.doc.sel;
    __t('pointerdown', 1, s.x, s.y); __t('pointerup', 1, s.x, s.y);
    return { panned, selAfterDrag, tapped: __ED.doc.sel };
});
check(sea.panned > 3 && sea.selAfterDrag !== 'Sea' && sea.tapped === 'Sea', `a drag across the sea pans the view; a tap selects the sea (${JSON.stringify(sea)})`);

// Select several: a box round the council island's lamps, then drag them all.
await page.keyboard.press('Escape');
await look(-10, 30, 9);
await page.click('#multi');
await wait(200);
await ev(async () => { await __drag(1, __at(-21, 0, 19), __at(1, 0, 41), 10); });
await wait(400);
const boxed = await ev(() => ({ n: [__ED.doc.sel, ...__ED.doc.multi].filter(Boolean).length, lamps: __ED.doc.multi.concat(__ED.doc.sel).filter(id => /Lanthe_Lamp/.test(id)).length, head: document.querySelector('#panel-body .kind')?.textContent }));
check(boxed.n >= 4 && boxed.lamps >= 4 && /selected/.test(boxed.head || ''), `Select several: a box selects everything inside it (${JSON.stringify(boxed)})`);
const start5 = await ev(() => Object.fromEntries([__ED.doc.sel, ...__ED.doc.multi].map(id => { const o = __ED.doc.scene.objects.find(q => q.id === id); return [id, [o.x, o.z]]; })));
await ev(async () => { const o = __ED.doc.scene.objects.find(q => q.id === 'Lanthe_Lamp_1'); await __drag(1, __at(o.x, 0, o.z), __at(o.x + 3, 0, o.z), 8); });
await wait(400);
const shifted5 = await ev(b => Object.entries(b).map(([id, [x, z]]) => { const o = __ED.doc.scene.objects.find(q => q.id === id); return [+(o.x - x).toFixed(2), +(o.z - z).toFixed(2)]; }), start5);
check(shifted5.length >= 4 && shifted5.every(([dx, dz]) => Math.abs(dx - shifted5[0][0]) < 0.01 && Math.abs(dz - shifted5[0][1]) < 0.01) && Math.abs(shifted5[0][0]) >= 2.5, `dragging one moves them all together (${JSON.stringify(shifted5.slice(0, 3))}…)`);
const nBefore = await ev(() => __ED.doc.scene.objects.length);
await page.click('#panel-body button:has-text("Delete all")');
await wait(400);
// The box takes in Oriel, whom Saltmere's story uses: the editor warns first.
const warned = await page.isVisible('.modal');
if (warned) { await page.click('.modal button:has-text("Delete")'); await wait(400); }
const nAfter = await ev(() => __ED.doc.scene.objects.length);
await page.click('#undo');
await wait(400);
const nBack = await ev(() => __ED.doc.scene.objects.length);
check(warned && nAfter === nBefore - shifted5.length && nBack === nBefore, `Delete all (warned: the story uses one), and one undo brings them all back (${nBefore} → ${nAfter} → ${nBack})`);
await page.click('#multi');

// A patrol route: the points show, and drag.
await ev(() => { __ED.doc.sel = null; const o = __ED.doc.scene.objects.find(q => q.id === 'Lanthe_Folk_1'); Object.assign(__ED.view.plan, { cx: o.x, cz: o.z, ppm: 14 }); __ED.view._cams(); });
await ev(() => { const o = __ED.doc.scene.objects.find(q => q.id === 'Lanthe_Folk_1'); const s = __at(o.x, __ED.view.groundY(o.x, o.z) + 1, o.z); __t('pointerdown', 1, s.x, s.y); __t('pointerup', 1, s.x, s.y); });
await wait(500);
const r0 = await ev(() => ({ sel: __ED.doc.sel, route: __ED.view.route(), rows: document.querySelectorAll('#panel-body .sec .rows .row').length }));
const p1 = r0.route?.[1];
if (p1) await ev(async p => { await __drag(1, __at(p.x, __ED.view.groundY(p.x, p.z) + 0.3, p.z), __at(p.x + 2, __ED.view.groundY(p.x, p.z) + 0.3, p.z + 1), 8); }, p1);
await wait(400);
await page.click('#panel-body button:has-text("+ Point")');
await wait(400);
const r1 = await ev(() => ({ route: __ED.view.route(), text: __ED.doc.scene.objects.find(q => q.id === 'Lanthe_Folk_1').route }));
check(r0.sel === 'Lanthe_Folk_1' && r0.route.length === 4 && r0.rows === 4 && r1.route.length === 5 && Math.abs(r1.route[1].x - (p1.x + 2)) < 0.6 && Math.abs(r1.route[1].z - (p1.z + 1)) < 0.6,
    `a patrolling character's route: its points listed and drawn, one dragged, one added (${JSON.stringify({ start5: r0.route?.length, after: r1.route.length, text: r1.text })})`);
await shot('E8-route');

// A flat scene becomes land.
await page.click('#more');
await wait(700);
await page.click('.sheet .it:has-text("Empty field") button');
await wait(1200);
await page.click('[data-tab=land]');
await wait(300);
await page.click('#panel-body button:has-text("Make it land")');
await wait(1200);
const madeLand = await ev(() => ({ size: __ED.doc.scene.settings.terrain?.size, drawn: !!__ED.view.terrain, errs: __ED.validate().filter(p => p.level === 'error').length }));
check(madeLand.size === 120 && madeLand.drawn && madeLand.errs === 0, `a flat scene becomes land, and the game's checks pass it (${JSON.stringify(madeLand)})`);

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
await browser.close();
server.close();
console.log(pass.map(p => '  ok   ' + p).join('\n'));
if (fail.length) console.log(fail.map(p => '  FAIL ' + p).join('\n'));
if (fail.length) { console.log('EDITOR FAIL'); process.exit(1); }
console.log('EDITOR PASS');
