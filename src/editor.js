// ============================================================
// ELEMENTAL-EDITOR — the app: library, view, panels, play, save
// ============================================================

import { TYPES, GROUPS, emptyScene, defaults } from '../game/src/scene/schema.js';
import { PREFABS } from '../game/src/data/prefabs.js';
import { validateScene } from '../game/src/scene/validate.js';
import { startGame } from '../game/src/Game.js';
import { runBench } from '../game/src/debug/Bench.js';
import { View } from './view.js';
import { h, $, toast, sheet, ask } from './ui.js';
import { doc, on, changed, load, json, dirty, undo, redo, canUndo, canRedo, addObject, select as selectObj, selected, duplicate, remove, readLocal, checkpoint, normalizeScript, selection, duplicateMany, removeMany, byId } from './doc.js';
import { inspectPanel, logicPanel, storyPanel, scenePanel, landPanel, checkPanel, isQuiet, offerPick, stopPicking, edit } from './panels.js';
import { initStore, hasStore, saveScene, listSaved, loadSaved, listVersions } from './store.js';

// Put in the page by scripts/build.js: the game's own scenes, and which game commit the models came from.
const { scenes: GAME_SCENES = {}, build: BUILD = { game: 'dev', built: '' } } = window.__EDITOR_DATA__ || {};

let view, problems = [], tabNow = 'inspect';
const api = { get view() { return view; }, tab: t => showTab(t) };

// ---- boot ------------------------------------------------------------------------------------

function boot() {
    view = new View($('view'), { onPick: id => offerPick(id) });
    view.onLive = o => livePosition(o);
    buildLibrary();
    bindBar();
    on(what => onChange(what));

    const local = readLocal();
    if (local) {
        load(local.scene, { source: local.source || 'device', saved: local.saved, savedAt: local.savedAt });
        if (dirty()) setTimeout(() => toast('Picked up where you left off on this device.'), 400);
    } else {
        load(GAME_SCENES.lesson1 || Object.values(GAME_SCENES)[0] || emptyScene(), { source: 'game' });
    }
    view.frame();
    initStore().then(ok => { $('save').title = ok ? 'Save for Claude' : 'Saving for Claude isn’t available here; your work is kept on this device'; status(); });
    window.__ED = { doc, view, load, changed, validate: () => problems, startPlay, stopPlay, GAME_SCENES };
}

function onChange(what) {
    if (what === 'all' || what === 'objects' || what.startsWith?.('object:') || what === 'wires' || what === 'settings') view.sync(what);
    if (what === 'selection') view.sync('selection');
    validateSoon();
    status();
    $('undo').disabled = !canUndo();
    $('redo').disabled = !canRedo();
    $('scene-name').textContent = doc.scene.name || doc.scene.id;
    if (isQuiet() && what !== 'selection') return;
    if (what === 'selection' && tabNow !== 'inspect' && tabNow !== 'land' && doc.sel && !$('panel').classList.contains('pinned')) showTab('inspect');
    else renderTab();
}

let vT = 0;
function validateSoon() {
    clearTimeout(vT);
    vT = setTimeout(() => {
        problems = validateScene(doc.scene);
        const errs = problems.filter(p => p.level === 'error');
        view.problems = new Set(errs.map(p => p.where).filter(id => doc.scene.objects.some(o => o.id === id)));
        view.sync('problems');
        const b = $('tab-check').querySelector('.count');
        b.textContent = problems.length ? String(problems.length) : '';
        b.className = 'count' + (errs.length ? ' bad' : problems.length ? ' warn' : '');
        if (tabNow === 'check') renderTab();
    }, 250);
}

function status() {
    const s = $('status');
    if (!doc.scene) return;
    if (dirty()) { s.textContent = doc.savedAt ? 'Unsaved changes' : 'Not saved for Claude yet'; s.className = 'dirty'; }
    else { s.textContent = 'Saved ' + new Date(doc.savedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); s.className = ''; }
}

// While dragging, the inspector's numbers follow without a redraw.
function livePosition(o) {
    if (o.id !== doc.sel) return;
    const set = (id, v) => { const el = $(id); if (el && document.activeElement !== el) el.value = v; };
    set('ins-x', o.x.toFixed(1)); set('ins-z', o.z.toFixed(1)); set('ins-r', (Math.round(o.rotY * 180 / Math.PI * 10) / 10).toFixed(1));
}

// ---- panels ----------------------------------------------------------------------------------------

const TABS = { inspect: inspectPanel, logic: logicPanel, story: storyPanel, scene: scenePanel, land: landPanel, check: checkPanel };

function showTab(t) {
    if (t !== 'land') view.setBrush(null);          // the brushes work only while the Land tab is open
    tabNow = t;
    for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
    document.body.classList.add('panel-open');
    renderTab();
    $('panel-body').scrollTop = 0;
}

function renderTab() {
    const root = $('panel-body');
    const top = root.scrollTop;
    const fn = TABS[tabNow];
    if (tabNow === 'check') fn(root, api, problems); else fn(root, api);
    root.scrollTop = top;
}

// ---- library ------------------------------------------------------------------------------------------

// What the library offers: every type, with each prefab building as its own card.
function libraryItems() {
    const items = [];
    for (const [type, t] of Object.entries(TYPES)) {
        if (type === 'prefab') {
            for (const [k, p] of Object.entries(PREFABS)) items.push({ key: 'prefab:' + k, type, group: t.group, label: p.label, extra: { prefab: k }, hint: `${p.footprint[0]} × ${p.footprint[1]} m` });
        } else items.push({ key: type, type, group: t.group, label: t.label, extra: {} });
    }
    return items;
}

let libGroup = 'All';
function buildLibrary() {
    const tabs = $('lib-tabs'), cards = $('lib-cards');
    const items = libraryItems();
    const draw = () => {
        tabs.replaceChildren(...['All', ...GROUPS].map(g => h('button.tab', { type: 'button', 'aria-pressed': String(g === libGroup), on: { click: () => { libGroup = g; draw(); } } }, g)));
        cards.replaceChildren(...items.filter(i => libGroup === 'All' || i.group === libGroup).map(i => h('button.lcard', {
            type: 'button', 'data-key': i.key, title: 'Add ' + i.label,
            on: { click: () => addFromLibrary(i) },
        }, h('span.thumb', { style: thumbs[i.key] ? { backgroundImage: `url(${thumbs[i.key]})` } : {} }), h('span.nm', i.label), i.hint ? h('span.ds', i.hint) : null)));
    };
    let thumbs = {};
    draw();
    // Pictures after the first paint: each type drawn by the game's own model code.
    setTimeout(() => {
        const want = {};
        for (const i of items) want[i.key] = { ...defaults(i.type), ...i.extra, type: i.type };
        try { thumbs = View.thumbnails(want, 112); } catch (e) { console.warn('thumbnails', e); }
        draw();
    }, 60);
}

function addFromLibrary(i) {
    const at = view.centre();
    addObject(i.type, at, i.extra);
    showTab('inspect');
    if (matchMedia('(max-width: 900px)').matches) document.body.classList.remove('lib-open');
    toast(`Added ${i.label}. Drag it into place.`);
}

// ---- the bar --------------------------------------------------------------------------------------------

function bindBar() {
    $('undo').onclick = () => undo();
    $('redo').onclick = () => redo();
    $('lib-toggle').onclick = () => document.body.classList.toggle('lib-open');
    $('panel-toggle').onclick = () => document.body.classList.toggle('panel-open');
    for (const b of document.querySelectorAll('#mode button')) b.onclick = () => {
        for (const x of document.querySelectorAll('#mode button')) x.setAttribute('aria-pressed', String(x === b));
        view.setMode(b.dataset.mode);
    };
    $('multi').onclick = () => {
        view.multi = !view.multi;
        $('multi').setAttribute('aria-pressed', String(view.multi));
        toast(view.multi ? 'Tap things to add them; drag on nothing to draw a box round more.' : 'One at a time.');
    };
    $('snap').onclick = () => { view.snap = !view.snap; $('snap').setAttribute('aria-pressed', String(view.snap)); toast(view.snap ? 'Snapping to half metres and 15°.' : 'Free placement.'); };
    $('wires-toggle').onclick = () => { view.show.wires = !view.show.wires; $('wires-toggle').setAttribute('aria-pressed', String(view.show.wires)); view.sync('overlay'); };
    $('frame').onclick = () => view.frame(doc.sel || null);
    $('play').onclick = () => startPlay();
    $('save').onclick = () => saveSheet();
    $('more').onclick = () => moreSheet();
    $('scene-name').onclick = () => showTab('scene');
    $('pickbar').querySelector('button').onclick = () => stopPicking();
    for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => showTab(b.dataset.tab);

    addEventListener('keydown', e => {
        const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName);
        const mod = e.metaKey || e.ctrlKey;
        if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); (e.shiftKey ? redo : undo)(); return; }
        if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveSheet(); return; }
        if (typing || $('play-root')) return;
        const o = selected(), many = doc.multi.length ? selection().map(byId).filter(Boolean) : null;
        if (many) {
            if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); removeMany(selection()); return; }
            if (e.key.toLowerCase() === 'd') { duplicateMany(selection()); return; }
            if (e.key.startsWith('Arrow')) {
                e.preventDefault();
                const s = e.shiftKey ? 1 : 0.1, dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0, dz = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0;
                edit(() => { for (const q of many) { q.x = +(q.x + dx).toFixed(2); q.z = +(q.z + dz).toFixed(2); } }, 'objects', true);
                return;
            }
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && o) { e.preventDefault(); remove(o.id); }
        else if (e.key.toLowerCase() === 'd' && o) duplicate(o.id);
        else if (e.key.toLowerCase() === 'f') view.frame(doc.sel || null);
        else if (e.key.toLowerCase() === 'r' && o) edit(() => { o.rotY = Math.round(((o.rotY || 0) + (e.shiftKey ? -1 : 1) * Math.PI / 12) * 1e4) / 1e4; }, 'object:' + o.id, true);
        else if (e.key === 'Escape') { stopPicking(); selectObj(null); }
        else if (e.key.startsWith('Arrow') && o) {
            e.preventDefault();
            const s = e.shiftKey ? 1 : 0.1;
            edit(() => {
                if (e.key === 'ArrowLeft') o.x = +(o.x - s).toFixed(2); if (e.key === 'ArrowRight') o.x = +(o.x + s).toFixed(2);
                if (e.key === 'ArrowUp') o.z = +(o.z - s).toFixed(2); if (e.key === 'ArrowDown') o.z = +(o.z + s).toFixed(2);
            }, 'object:' + o.id, true);
        }
    });
    addEventListener('beforeunload', () => { /* the device copy is written as you work */ });
}

// ---- save, open, versions ------------------------------------------------------------------------------------

async function saveSheet() {
    await initStore();
    const errs = problems.filter(p => p.level === 'error');
    await sheet('Save for Claude', close => {
        const note = h('textarea#save-note', { rows: '3', placeholder: 'What changed, e.g. “Moved the smithy, added a second plate to the gate.”' });
        const go = h('button.btn.primary', { type: 'button' }, 'Save');
        go.onclick = async () => {
            go.disabled = true; go.textContent = 'Saving…';
            try {
                const at = await saveScene(JSON.parse(json()), note.value.trim(), BUILD.game);
                doc.saved = json(); doc.savedAt = at;
                changed('selection');
                status();
                close(true);
                toast(`Saved “${doc.scene.name}”. Ask Claude to pull scene “${doc.scene.id}”.`, 'good');
            } catch (e) {
                go.disabled = false; go.textContent = 'Save';
                toast(e.message || 'Saving failed. Try again in a moment.', 'bad');
            }
        };
        return h('div.stack',
            hasStore()
                ? h('p', 'Stores this scene where Claude can read it, with a note, and keeps it as a version. Then ask Claude to pull the scene into the game.')
                : h('p.bad', 'Saving for Claude isn’t available in this view. Your work is kept on this device; use More → Copy scene JSON to hand it over another way.'),
            errs.length ? h('p.warnline', `${errs.length} problem${errs.length > 1 ? 's' : ''} would stop the game loading this scene (see Check). You can still save it.`) : null,
            h('div.field', h('label', { for: 'save-note' }, 'Note for Claude'), note),
            h('div.acts', h('button.btn', { type: 'button', on: { click: () => close(false) } }, 'Cancel'), hasStore() ? go : null));
    });
}

async function openScene(scene, opts) {
    if (dirty() && doc.savedAt !== null && !await ask('Leave unsaved changes?', `“${doc.scene.name}” has changes that aren’t saved for Claude. They stay on this device only until you open something else.`, 'Open anyway', 'Stay')) return false;
    if (dirty() && doc.savedAt === null && doc.source !== 'game' && !await ask('Leave this scene?', `“${doc.scene.name}” hasn’t been saved for Claude.`, 'Open anyway', 'Stay')) return false;
    load(scene, opts);
    view.frame();
    showTab(doc.scene.script ? 'story' : 'scene');
    return true;
}

async function moreSheet() {
    await initStore();
    await sheet('Scenes', close => {
        const wrap = h('div.stack');
        const item = (title, sub, act, label = 'Open') => h('div.it', h('div', h('b', title), h('span', sub)), h('button.btn.small', { type: 'button', on: { click: act } }, label));

        wrap.append(h('h3', 'From the game'), h('div.list', ...Object.values(GAME_SCENES).map(s => item(s.name, `${s.objects.length} objects · ${s.id}.json`, async () => { if (await openScene(s, { source: 'game' })) close(); }))));

        const saved = h('div.list', h('p.dim', hasStore() ? 'Loading…' : 'Not available in this view.'));
        wrap.append(h('h3', 'Saved for Claude'), saved);
        if (hasStore()) listSaved().then(list => {
            saved.replaceChildren(...(list.length ? list.map(s => item(s.name || s.id, `${s.objects ?? '?'} objects · ${s.savedAt ? new Date(s.savedAt).toLocaleString() : ''}${s.note ? ' · ' + s.note : ''}`, async () => {
                const d = await loadSaved(s.id);
                if (d?.scene && await openScene(d.scene, { source: 'saved', saved: JSON.stringify(normalizeCopy(d.scene)), savedAt: d.savedAt })) close();
            })) : [h('p.dim', 'Nothing saved yet. Save for Claude puts the scene here.')]));
        }).catch(() => saved.replaceChildren(h('p.bad', 'Couldn’t read the saved scenes. Try again in a moment.')));

        wrap.append(h('h3', 'New'), h('div.list',
            item('Empty field', 'Grass, a player start, nothing else', async () => { if (await openScene(emptyScene(uniqueSceneId('new-scene'), 'New scene'), { source: 'new' })) close(); }, 'Create'),
            GAME_SCENES.village ? item('Village starter', 'A copy of the sample village to build from', async () => {
                const s = JSON.parse(JSON.stringify(GAME_SCENES.village));
                s.id = uniqueSceneId('town'); s.name = 'New town';
                if (await openScene(s, { source: 'new' })) close();
            }, 'Create') : null));

        wrap.append(h('h3', 'This scene'), h('div.list',
            item('Versions', 'Every save for Claude of this scene', async () => { close(); versionsSheet(); }, 'Show'),
            item('Copy scene JSON', 'To paste somewhere else', async () => {
                try { await navigator.clipboard.writeText(JSON.stringify(doc.scene, null, 1)); toast('Copied.'); }
                catch (e) { close(); jsonSheet(true); }
            }, 'Copy'),
            item('Paste scene JSON', 'Replace this scene with one you paste', async () => { close(); jsonSheet(false); }, 'Paste'),
            item('Help', 'Touches, keys, and how scenes reach the game', () => { close(); helpSheet(); }, 'Read')));
        wrap.append(h('p.dim.small', `Models from the game at ${BUILD.game}${BUILD.built ? ' · built ' + BUILD.built : ''}.`));
        return wrap;
    }, { wide: true });
}

const normalizeCopy = s => { const c = JSON.parse(JSON.stringify(s)); if (c.script) normalizeScript(c.script); return c; };

function uniqueSceneId(base) {
    const taken = new Set(Object.keys(GAME_SCENES));
    for (let n = 1; ; n++) { const id = `${base}-${n}`; if (!taken.has(id)) return id; }
}

async function versionsSheet() {
    await sheet('Versions of ' + (doc.scene.name || doc.scene.id), close => {
        const list = h('div.list', h('p.dim', hasStore() ? 'Loading…' : 'Not available in this view.'));
        if (hasStore()) listVersions(doc.scene.id).then(vs => list.replaceChildren(...(vs.length ? vs.map(v => h('div.it',
            h('div', h('b', new Date(v.savedAt).toLocaleString()), h('span', `${v.objects} objects${v.note ? ' · ' + v.note : ''}`)),
            h('button.btn.small', { type: 'button', on: { click: () => { checkpoint(); const keepSaved = doc.saved, at = doc.savedAt; load(v.scene, { source: 'saved', saved: keepSaved, savedAt: at }); view.frame(); close(); toast('Opened that version. Save for Claude to make it the latest.'); } } }, 'Open')))
            : [h('p.dim', 'No saves of this scene yet.')])));
        return list;
    }, { wide: true });
}

async function jsonSheet(copy) {
    await sheet(copy ? 'Scene JSON' : 'Paste a scene', close => {
        const ta = h('textarea#json-box', { rows: '12', spellcheck: 'false' });
        if (copy) { ta.value = JSON.stringify(doc.scene, null, 1); setTimeout(() => ta.select(), 50); }
        const go = h('button.btn.primary', {
            type: 'button', on: {
                click: async () => {
                    let s;
                    try { s = JSON.parse(ta.value); } catch (e) { toast('That isn’t JSON: ' + e.message, 'bad'); return; }
                    if (!s || !Array.isArray(s.objects)) { toast('That isn’t a scene: it has no objects list.', 'bad'); return; }
                    if (await openScene(s, { source: 'pasted' })) close();
                },
            },
        }, 'Open it');
        return h('div.stack', h('p', copy ? 'Select all and copy.' : 'Paste a scene’s JSON (from Copy scene JSON, or a file in the game’s scenes/ folder).'), ta,
            h('div.acts', h('button.btn', { type: 'button', on: { click: () => close() } }, 'Close'), copy ? null : go));
    }, { wide: true });
}

function helpSheet() {
    const row = (k, v) => [h('dt', k), h('dd', v)];
    return sheet('How it works', () => h('div.stack',
        h('dl.help',
            ...row('Add', 'Tap something in the library. It lands in the middle of the view, selected.'),
            ...row('Move', 'Drag it with one finger. Snap keeps it on half metres and 15° turns.'),
            ...row('Turn', 'Drag the gold handle. It marks the front.'),
            ...row('Height', 'Inspect → Height, e.g. an upper floor at 3. On land, it is above the ground.'),
            ...row('Several', 'Select several (the bar): tap to add or take out, drag on nothing to draw a box; drag one to move them all.'),
            ...row('Land', 'Land tab: make the scene land, then raise, lower, smooth, flatten or paint it with one finger.'),
            ...row('Routes', 'A character set to patrol shows its route as gold points: drag them, or add them in Inspect.'),
            ...row('Look around', 'Plan is straight down; 3D orbits. Drag empty ground; pinch to zoom; two fingers pan.'),
            ...row('Puzzles', 'Logic: a wire watches signals (a plate is weighted) and makes things act (a gate opens). Blue dashes in the view show wires.'),
            ...row('Story', 'Steps of lines, an objective, and endings that say what the player must do.'),
            ...row('Try it', 'Play puts you in the scene with the elements live. Stop comes back to the same spot.'),
            ...row('Keys', 'Ctrl/⌘Z undo · ⇧ redo · D duplicate · R turn · Delete · arrows nudge (⇧ 1 m) · F frame')),
        h('p', 'Save for Claude, then ask Claude to pull the scene: it goes into the game’s scenes/ folder and plays at ?scene=<file name>.')));
}

// ---- play ------------------------------------------------------------------------------------------------------

let game = null;
function startPlay({ bench = false } = {}) {
    if (game) return;
    // The benchmark always plays the game's own Verdant Reach (its path runs through Thornwick), whatever is open.
    if (bench && !GAME_SCENES.verdant) { toast('The benchmark needs the Verdant Reach, which this build lacks.', 'bad'); return; }
    const errs = bench ? [] : problems.filter(p => p.level === 'error');
    const data = bench ? JSON.parse(JSON.stringify(GAME_SCENES.verdant)) : JSON.parse(json());
    const root = h('div#play-root',
        h('canvas#play-canvas'),
        h('div#play-hud'),
        h('div.play-bar',
            h('span.play-tag', bench ? 'Benchmark · ' : 'Playing · ', data.name || data.id),
            h('button.btn.small', { type: 'button', title: 'A fixed 46 s run through Thornwick, with two cottages burning: measures the frame rate', on: { click: () => { stopPlay(); startPlay({ bench: true }); } } }, 'Bench'),
            h('button.btn.small', { type: 'button', on: { click: () => { stopPlay(); startPlay({ bench }); } } }, 'Restart'),
            h('button.btn.primary', { type: 'button', on: { click: () => stopPlay() } }, 'Stop')));
    document.body.append(root);
    view.paused = true;
    try {
        game = startGame({ canvas: $('play-canvas'), hudEl: $('play-hud'), data, persist: false, onLink: () => { stopPlay(); startPlay(); } });
        window.__EL = game.api;
        if (bench) { const g = game; setTimeout(() => { if (game === g) runBench(g.api); }, 1500); }
        if (errs.length) toast(`${errs.length} problem${errs.length > 1 ? 's' : ''} in Check: some things may not work.`, 'bad');
    } catch (e) {
        console.error(e);
        stopPlay();
        toast('The scene didn’t start: ' + e.message, 'bad');
    }
}

function stopPlay() {
    try { game?.stop(); } catch (e) { console.error(e); }
    game = null;
    window.__EL = null;
    $('play-root')?.remove();
    document.getElementById('bench-card')?.remove();
    view.paused = false;
    view.resize();
}

boot();
