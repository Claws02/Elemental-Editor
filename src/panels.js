// ============================================================
// PANELS — Inspect, Logic, Story, Scene, Check
// ============================================================
//
// Each panel draws from doc.scene and writes back through `edit()`, which
// takes an undo checkpoint and tells everyone what changed. Typing in a
// field doesn't redraw the panel (the field keeps focus); adding or
// removing rows does.
// ============================================================

import { TYPES, GROUPS, CONDITIONS, ACTIONS, ELEMENTS, TRACKS, TALLIES, REACTION_EVENTS, GROUND_STYLES, PROFILES, REGION_NAMES, signalsOf, actionsOf } from '../game/src/scene/schema.js';
import { PREFABS, expandPrefab } from '../game/src/data/prefabs.js';
import { withDefaults } from '../game/src/scene/Catalog.js';
import { h, $, field, numberInput, textInput, linesInput, select, toggle, seg, ask, toast, fmt } from './ui.js';
import { doc, changed, checkpoint, byId, selected, select as selectObj, duplicate, remove, rename, usesOf, uniqueId, normalizeScript } from './doc.js';

let quiet = false;        // a panel is writing: don't redraw panels for it
export const isQuiet = () => quiet;

/** Change the scene: undo checkpoint, the change, then tell everyone. */
export function edit(fn, what = 'all', redraw = false) {
    checkpoint();
    fn();
    quiet = !redraw;
    try { changed(what); } finally { quiet = false; }
}

// ---- shared bits ------------------------------------------------------------------------------

const typeLabel = t => TYPES[t]?.label || t;
const deg = r => Math.round((r || 0) * 180 / Math.PI * 10) / 10;

function objectOptions(types = null) {
    return doc.scene.objects.filter(o => !types || types.includes(o.type)).map(o => [o.id, `${o.id} · ${typeLabel(o.type)}`]);
}

/** An object chooser, with a "Pick" button that takes the next tap in the view. */
export function refInput(value, { types = null, onChange, empty = 'None' } = {}) {
    const s = select(value || '', objectOptions(types), { onChange, empty });
    if (value && !byId(value)) s.append(h('option', { value, selected: true }, `${value} (missing)`));
    const pickBtn = h('button.btn.small', { type: 'button', title: 'Tap an object in the view' }, 'Pick');
    pickBtn.addEventListener('click', () => startPicking(types, id => { s.value = id; onChange?.(id); }));
    return h('span.refwrap', s, pickBtn);
}

let picking = null;
export function startPicking(types, cb) {
    picking = { types, cb };
    const b = $('pickbar');
    b.hidden = false;
    b.querySelector('span').textContent = types ? `Tap a ${types.map(typeLabel).join(' or ')} in the view` : 'Tap an object in the view';
}
export function stopPicking() { picking = null; $('pickbar').hidden = true; }
/** The view calls this on a tap; true when a pick prompt took it. */
export function offerPick(id) {
    if (!picking) return false;
    const o = byId(id);
    if (picking.types && !picking.types.includes(o?.type)) { toast(`That's a ${typeLabel(o?.type)}. Tap a ${picking.types.map(typeLabel).join(' or ')}.`, 'bad'); return true; }
    const cb = picking.cb;
    stopPicking();
    cb(id);
    return true;
}

function rowList(items, render, { add, addLabel, empty } = {}) {
    const wrap = h('div.rows');
    items.forEach((it, i) => wrap.append(render(it, i)));
    if (!items.length && empty) wrap.append(h('p.empty', empty));
    if (add) wrap.append(h('button.btn.small.add', { type: 'button', on: { click: add } }, '+ ', addLabel));
    return wrap;
}

const xBtn = (label, fn) => h('button.btn.small.ghost.x', { type: 'button', 'aria-label': label, title: label, on: { click: fn } }, '✕');

// ==== INSPECT ======================================================================================

export function inspectPanel(root, api) {
    const o = selected();
    root.replaceChildren();
    if (!o) {
        const counts = {};
        for (const x of doc.scene.objects) counts[TYPES[x.type]?.group || 'Other'] = (counts[TYPES[x.type]?.group || 'Other'] || 0) + 1;
        root.append(
            h('div.empty-state',
                h('h3', 'Nothing selected'),
                h('p', 'Tap a thing in the view to change it, or add one from the library.'),
                h('dl.counts', ...GROUPS.filter(g => counts[g]).flatMap(g => [h('dt', g), h('dd', String(counts[g]))]))));
        return;
    }
    const t = TYPES[o.type];
    const full = withDefaults(o);
    const idIn = textInput(o.id, { onChange: v => { if (!rename(o.id, v)) { idIn.value = o.id; toast('That name is taken or empty.', 'bad'); } } });
    root.append(h('div.ins-head',
        h('span.kind', t.label),
        field('Name', idIn, 'Wires and the story find it by this name.')));
    if (t.note) root.append(h('p.note', t.note));

    // Where it stands.
    const pos = h('div.grid4');
    const setNum = (k, v, what = 'object:' + o.id) => edit(() => { o[k] = v; }, what);
    pos.append(
        field('X', numberInput(o.x, { step: 0.1, id: 'ins-x', onChange: v => setNum('x', v) })),
        field('Z', numberInput(o.z, { step: 0.1, id: 'ins-z', onChange: v => setNum('z', v) })),
        field('Height', numberInput(o.y || 0, { step: 0.1, min: -5, max: 60, id: 'ins-y', onChange: v => setNum('y', v) })),
        field('Turn °', numberInput(deg(o.rotY), { step: 15, id: 'ins-r', onChange: v => setNum('rotY', Math.round(v * Math.PI / 180 * 1e4) / 1e4) })));
    root.append(h('section.sec', h('h4', 'Place'), pos));

    // Its properties.
    const props = Object.entries(t.props);
    if (props.length) {
        const box = h('div.props');
        for (const [k, f] of props) {
            const v = full[k];
            const set = (val, redraw = false) => edit(() => {
                if (k === 'hidden' && !val) delete o[k]; else o[k] = val;
            }, 'object:' + o.id, redraw);
            let c;
            if (f.kind === 'number' || f.kind === 'int') c = numberInput(v, { min: f.min, max: f.max, step: f.kind === 'int' ? 1 : f.step, onChange: x => set(f.kind === 'int' ? Math.round(x) : x) });
            else if (f.kind === 'bool') c = toggle(v, { onChange: set });
            else if (f.kind === 'select') c = f.options.length <= 4 ? seg(v, f.options, { onChange: set }) : select(v, f.options, { onChange: set });
            else if (f.kind === 'text') c = textInput(v, { onChange: set });
            else if (f.kind === 'ref') c = refInput(v, { types: f.types, onChange: set });
            box.append(field(f.label, c));
        }
        root.append(h('section.sec', h('h4', 'Properties'), box));
    }

    // What it can do in a puzzle.
    const sigs = signalsOf(o.type), acts = [...actionsOf(o.type), ...('hidden' in t.props ? ['reveal', 'hide'] : [])];
    if (sigs.length || acts.length) {
        root.append(h('section.sec', h('h4', 'In puzzles'),
            sigs.length ? h('p.chips', h('b', 'Signals '), ...sigs.map(s => h('span.chip.sig', s))) : null,
            acts.length ? h('p.chips', h('b', 'Actions '), ...acts.map(s => h('span.chip.act', s))) : null));
    }
    const uses = usesOf(o.id);
    if (uses.length) root.append(h('p.note', 'Used by ', uses.join(', '), '.'));

    // Buttons.
    const acts2 = h('div.acts');
    acts2.append(h('button.btn', { type: 'button', on: { click: () => api.view.frame(o.id) } }, 'Frame'));
    if (!t.single) acts2.append(h('button.btn', { type: 'button', on: { click: () => duplicate(o.id) } }, 'Duplicate'));
    if (o.type === 'prefab') acts2.append(h('button.btn', { type: 'button', on: { click: () => breakApart(o) } }, 'Break apart'));
    acts2.append(h('button.btn.danger', {
        type: 'button', on: {
            click: async () => {
                const u = usesOf(o.id);
                if (u.length && !await ask('Delete ' + o.id + '?', `It is used by ${u.join(', ')}. Those references will point at nothing.`, 'Delete', 'Keep it', true)) return;
                remove(o.id);
            },
        },
    }, 'Delete'));
    root.append(acts2);
}

function breakApart(o) {
    edit(() => {
        const pieces = expandPrefab(withDefaults(o));
        const i = doc.scene.objects.indexOf(o);
        const base = o.id;
        doc.scene.objects.splice(i, 1);
        const made = pieces.map(p => {
            const { id, ...rest } = p;
            const n = { id: '', ...rest };
            doc.scene.objects.push(n);
            n.id = uniqueId(`${base}_${TYPES[p.type]?.label.replace(/\W/g, '') || p.type}`);
            for (const k of ['x', 'y', 'z', 'rotY']) n[k] = Math.round(n[k] * 1000) / 1000;
            return n;
        });
        doc.sel = made[0]?.id || null;
    }, 'all', true);
    toast(`${o.id} is now ${PREFABS[o.prefab]?.pieces.length} pieces.`);
}

// ==== LOGIC (wires) =================================================================================

function signalChoices(id) { const o = byId(id); return o ? signalsOf(o.type) : []; }
function actionChoices(id) { const o = byId(id); if (!o) return []; return [...actionsOf(o.type), ...('hidden' in (TYPES[o.type]?.props || {}) ? ['reveal', 'hide'] : [])]; }
const signalTypes = () => Object.keys(TYPES).filter(t => signalsOf(t).length);
const actionTypes = () => Object.keys(TYPES).filter(t => actionsOf(t).length || 'hidden' in TYPES[t].props);

export function logicPanel(root, api) {
    const redraw = () => logicPanel(root, api);
    root.replaceChildren(h('p.lede', 'A wire watches signals from objects and, when they hold, makes other objects act. Two plates that raise a barricade are one wire.'));
    const wires = doc.scene.wires;
    wires.forEach((w, wi) => {
        const card = h('section.card');
        const idIn = textInput(w.id, { onChange: v => edit(() => { w.id = v.trim() || w.id; }, 'wires') });
        card.append(h('div.card-head', field('Wire', idIn), xBtn('Delete wire', () => edit(() => wires.splice(wi, 1), 'wires', true) || redraw())));
        card.append(h('div.row',
            field('When', seg(w.mode || 'all', [['all', 'All of these'], ['any', 'Any of these']], { onChange: v => edit(() => { w.mode = v; }, 'wires') })),
            field('Only once', toggle(!!w.once, { onChange: v => edit(() => { if (v) w.once = true; else delete w.once; }, 'wires') }))));
        const io = (list, kind) => rowList(list, (x, i) => {
            const choices = kind === 'in' ? signalChoices(x.obj) : actionChoices(x.obj);
            const key = kind === 'in' ? 'signal' : 'action';
            return h('div.io',
                refInput(x.obj, { types: kind === 'in' ? signalTypes() : actionTypes(), onChange: v => { edit(() => { x.obj = v; const c = kind === 'in' ? signalChoices(v) : actionChoices(v); if (!c.includes(x[key])) x[key] = c[0] || ''; }, 'wires', true); redraw(); } }),
                select(x[key], choices, { onChange: v => edit(() => { x[key] = v; }, 'wires') }),
                xBtn('Remove', () => { edit(() => list.splice(i, 1), 'wires', true); redraw(); }));
        }, {
            add: () => { edit(() => list.push(kind === 'in' ? { obj: '', signal: '' } : { obj: '', action: '' }), 'wires', true); redraw(); },
            addLabel: kind === 'in' ? 'signal' : 'action',
        });
        w.inputs ||= []; w.do ||= [];
        card.append(h('h5', 'Signals'), io(w.inputs, 'in'));
        card.append(h('h5', 'Then'), io(w.do, 'out'));
        card.append(h('h5', 'When it stops holding ', h('small', '(optional)')), io(w.undo ||= [], 'out'));
        root.append(card);
    });
    root.append(h('button.btn.primary', {
        type: 'button', on: {
            click: () => {
                const ids = new Set(wires.map(w => w.id));
                let n = wires.length + 1; while (ids.has('Wire_' + n)) n++;
                edit(() => wires.push({ id: 'Wire_' + n, mode: 'all', inputs: [{ obj: '', signal: '' }], do: [{ obj: '', action: '' }] }), 'wires', true);
                redraw();
            },
        },
    }, '+ Add a wire'));
}

// ==== STORY (script) ==================================================================================

const CKINDS = Object.entries(CONDITIONS).map(([k, c]) => [k, c.label]);
const AKINDS = Object.entries(ACTIONS).map(([k, a]) => [k, a.label]);
const wireIds = () => doc.scene.wires.map(w => w.id);

function newCond(kind) {
    switch (kind) {
    case 'talking': return { talking: false };
    case 'time': return { time: 10 };
    case 'held': return { held: '*' };
    case 'heldFor': return { heldFor: { obj: '', secs: 3, lost: [] } };
    case 'signal': return { signal: { obj: '', name: '' } };
    case 'wire': return { wire: wireIds()[0] || '' };
    case 'broken': case 'burned': return { [kind]: { obj: '', min: 1 } };
    case 'burning': return { burning: true };
    case 'count': return { count: { name: '', min: 1 } };
    case 'all': case 'any': return { [kind]: [{ talking: false }] };
    case 'not': return { not: { talking: false } };
    case 'flag': return { flag: { name: '', is: '' } };
    case 'state': return { state: { id: '', is: '' } };
    case 'ledger': return { ledger: { tally: 'harm', min: 1 } };
    case 'standing': return { standing: { region: doc.scene.settings?.region || 'verdant', atLeast: 3 } };
    }
    return { talking: false };
}

/** A condition, editable in place. `set(c)` replaces it in its parent. */
export function condEditor(c, set, redraw) {
    const [k, v] = Object.entries(c || { talking: false })[0];
    const kind = select(k, CKINDS, { onChange: nk => { set(newCond(nk)); redraw(); } });
    const box = h('div.cond', h('div.cond-kind', kind));
    const put = nv => set({ [k]: nv });
    const args = h('div.cond-args');
    switch (k) {
    case 'talking': case 'burning':
        args.append(seg(String(!!v), [['true', 'Yes'], ['false', 'No']], { onChange: x => put(x === 'true') })); break;
    case 'time':
        args.append(numberInput(v, { min: 0, max: 3600, step: 1, onChange: put }), h('span.unit', 's')); break;
    case 'held':
        args.append(select(v, [['*', 'anything'], ...objectOptions()], { onChange: put })); break;
    case 'heldFor':
        args.append(refInput(v.obj, { onChange: x => put({ ...v, obj: x }) }), numberInput(v.secs, { min: 0.5, max: 60, step: 0.5, onChange: x => put({ ...v, secs: x }) }), h('span.unit', 's'));
        args.append(field('If dropped early, say', linesInput(v.lost, { rows: 1, onChange: x => put({ ...v, lost: x }) }))); break;
    case 'signal': {
        const obj = refInput(v.obj, { types: signalTypes(), onChange: x => { put({ obj: x, name: signalChoices(x)[0] || '' }); redraw(); } });
        args.append(obj, select(v.name, signalChoices(v.obj), { onChange: x => put({ ...v, name: x }) })); break;
    }
    case 'wire':
        args.append(select(v, wireIds(), { onChange: put, empty: 'Choose a wire' })); break;
    case 'broken': case 'burned':
        args.append(refInput(v.obj, { types: ['barricade'], onChange: x => put({ ...v, obj: x }) }), h('span.unit', '≥'), numberInput(v.min ?? 1, { min: 1, max: 100, step: 1, onChange: x => put({ ...v, min: x }) })); break;
    case 'count':
        args.append(textInput(v.name, { placeholder: 'counter', onChange: x => put({ ...v, name: x }) }), h('span.unit', '≥'), numberInput(v.min ?? 1, { min: 0, max: 999, step: 1, onChange: x => put({ ...v, min: x }) })); break;
    case 'all': case 'any': {
        const list = v;
        const with_ = f => { const l = list.slice(); f(l); return l; };
        args.append(rowList(list, (child, i) => h('div.nest', condEditor(child, nc => put(with_(l => { l[i] = nc; })), redraw), xBtn('Remove', () => { put(with_(l => l.splice(i, 1))); redraw(); })),
            { add: () => { put(with_(l => l.push({ talking: false }))); redraw(); }, addLabel: 'condition' }));
        break;
    }
    case 'not':
        args.append(h('div.nest', condEditor(v, nc => put(nc), redraw))); break;
    case 'flag':
        args.append(textInput(v.name, { placeholder: 'flag name', onChange: x => put({ ...v, name: x }) }), h('span.unit', 'is'),
            textInput(v.is ?? '', { placeholder: 'set (any value)', onChange: x => put({ ...v, is: x }) })); break;
    case 'state':
        args.append(refInput(v.id, { onChange: x => put({ ...v, id: x }) }), h('span.unit', 'is'),
            textInput(v.is ?? '', { placeholder: 'burned, Collapsed, revealed, open…', onChange: x => put({ ...v, is: x }) })); break;
    case 'ledger':
        args.append(select(v.tally, TALLIES, { onChange: x => put({ ...v, tally: x }) }), h('span.unit', '≥'),
            numberInput(v.min ?? 1, { min: 0, max: 999, step: 0.5, onChange: x => put({ ...v, min: x }) }),
            select(v.region || '', Object.entries(REGION_NAMES), { empty: 'this kingdom', onChange: x => put({ ...v, region: x || undefined }) })); break;
    case 'standing':
        args.append(select(v.region, Object.entries(REGION_NAMES), { onChange: x => put({ ...v, region: x }) }), h('span.unit', 'at least'),
            select(String(v.atLeast ?? 2), [['0', 'the cause of all this'], ['1', 'dangerous'], ['2', 'unpredictable'], ['3', 'necessary'], ['4', 'saviour']], { onChange: x => put({ ...v, atLeast: +x }) })); break;
    }
    box.append(args);
    return box;
}

function newAction(kind) {
    switch (kind) {
    case 'say': return { say: [] };
    case 'do': return { do: { obj: '', action: '' } };
    case 'reveal': case 'hide': return { [kind]: [] };
    case 'grant': return { grant: { el: 'earth', track: 'control', amount: 0.1 } };
    case 'flag': return { flag: { name: '', add: 1 } };
    case 'count': return { count: { name: '', add: 1 } };
    case 'saveFlag': return { saveFlag: doc.scene.id };
    case 'card': return { card: true };
    case 'checkpoint': return { checkpoint: true };
    case 'travel': return { travel: { scene: '', at: 'start' } };
    case 'setFlag': return { setFlag: { name: '', value: 'true' } };
    case 'setState': return { setState: { id: '', value: '' } };
    case 'ledger': return { ledger: { tally: 'care', add: 1 } };
    }
    return { say: [] };
}

export function actionEditor(a, set, redraw) {
    const [k, v] = Object.entries(a || { say: [] })[0];
    const put = nv => set({ [k]: nv });
    const box = h('div.act', h('div.cond-kind', select(k, AKINDS, { onChange: nk => { set(newAction(nk)); redraw(); } })));
    const args = h('div.cond-args');
    switch (k) {
    case 'say': args.append(linesInput(v, { rows: 2, onChange: put })); break;
    case 'do': {
        args.append(refInput(v.obj, { types: actionTypes(), onChange: x => { put({ obj: x, action: actionChoices(x)[0] || '' }); redraw(); } }),
            select(v.action, actionChoices(v.obj), { onChange: x => put({ ...v, action: x }) }));
        break;
    }
    case 'reveal': case 'hide': {
        const list = [].concat(v).slice();
        const hideable = Object.keys(TYPES).filter(t => 'hidden' in TYPES[t].props);
        args.append(h('div.chips', ...list.map((id, i) => h('span.chip.obj', id, h('button', { type: 'button', 'aria-label': 'Remove ' + id, on: { click: () => { list.splice(i, 1); put(list); redraw(); } } }, '✕')))));
        args.append(refInput('', { types: hideable, empty: 'Add an object…', onChange: x => { if (x && !list.includes(x)) { list.push(x); put(list); redraw(); } } }));
        if (k === 'reveal') args.append(h('button.btn.small', { type: 'button', on: { click: () => { const ids = doc.scene.objects.filter(o => o.hidden).map(o => o.id); put([...new Set([...list, ...ids])]); redraw(); } } }, 'Every hidden object'));
        break;
    }
    case 'grant':
        args.append(select(v.el, ELEMENTS, { onChange: x => put({ ...v, el: x }) }), select(v.track, TRACKS, { onChange: x => put({ ...v, track: x }) }),
            numberInput(v.amount, { min: -1, max: 1, step: 0.05, onChange: x => put({ ...v, amount: x }) }));
        break;
    case 'flag': case 'count':
        args.append(textInput(v.name, { placeholder: k === 'flag' ? 'flag (saved)' : 'counter', onChange: x => put({ ...v, name: x }) }),
            h('span.unit', 'add'), numberInput(v.add, { min: -100, max: 100, step: 1, onChange: x => put({ ...v, add: x }) }));
        break;
    case 'saveFlag': args.append(textInput(v, { onChange: put }), h('small.hint', 'Saves the outcome and counters on the device under this name.')); break;
    case 'card': args.append(h('small.hint', 'Shows the end card (below).')); break;
    case 'checkpoint': args.append(h('small.hint', 'Saves here: dying comes back to this point.')); break;
    case 'travel':
        args.append(textInput(v.scene, { placeholder: 'scene file name', onChange: x => put({ ...v, scene: x }) }), h('span.unit', 'at'),
            textInput(v.at || 'start', { placeholder: 'start point name', onChange: x => put({ ...v, at: x }) })); break;
    case 'setFlag':
        args.append(textInput(v.name, { placeholder: 'flag name', onChange: x => put({ ...v, name: x }) }), h('span.unit', '='),
            textInput(String(v.value ?? ''), { placeholder: 'true, a number, a word', onChange: x => put({ ...v, value: x }) })); break;
    case 'setState':
        args.append(refInput(v.id, { onChange: x => put({ ...v, id: x }) }), h('span.unit', '='),
            textInput(v.value || '', { placeholder: 'burned, rebuilt… (empty clears it)', onChange: x => put({ ...v, value: x }) })); break;
    case 'ledger':
        args.append(select(v.tally, TALLIES, { onChange: x => put({ ...v, tally: x }) }), h('span.unit', 'add'),
            numberInput(v.add, { min: -50, max: 50, step: 0.5, onChange: x => put({ ...v, add: x }) })); break;
    }
    box.append(args);
    return box;
}

/** `w(fn, redraw)` makes the change inside an undo step. */
function actionList(list, w, redraw, label = 'action') {
    return rowList(list, (a, i) => h('div.nest', actionEditor(a, na => w(() => { list[i] = na; }), redraw), xBtn('Remove', () => w(() => list.splice(i, 1), true))),
        { add: () => w(() => list.push({ say: [] }), true), addLabel: label });
}

let openSteps = new Set();

export function storyPanel(root, api) {
    const redraw = () => { const top = root.scrollTop; storyPanel(root, api); root.scrollTop = top; };
    root.replaceChildren();
    const s = doc.scene.script;
    const npcs = doc.scene.objects.filter(o => o.type === 'npc');
    if (!s) {
        root.append(h('div.empty-state',
            h('h3', 'No story in this scene'),
            h('p', 'A story is a list of steps: what the speaker says, what the player should do, and what happens when they do it. Lesson I is one.'),
            h('button.btn.primary', {
                type: 'button', on: {
                    click: () => {
                        edit(() => {
                            doc.scene.script = normalizeScript({
                                id: doc.scene.id, speaker: npcs[0]?.id || '', face: npcs[0]?.id || '', flags: {},
                                steps: [{ id: 'start', say: ['…'], ends: [{ when: { talking: false } }] }], reactions: [],
                                card: { title: doc.scene.name, lines: ['{outcome}'], buttons: [{ label: 'Again', href: `?scene=${doc.scene.id}` }] },
                            });
                            if (doc.scene.settings.profile !== 'story') doc.scene.settings.profile = 'story';
                        }, 'script', true);
                        redraw();
                    },
                },
            }, 'Add a story')));
        return;
    }
    const w = (fn, again = false) => { edit(fn, 'script', again); if (again) redraw(); };
    const S = () => doc.scene.script;       // after undo the object is new; always read it fresh

    // Who, and how it opens.
    root.append(h('section.sec',
        h('div.grid2',
            field('Speaker', select(s.speaker, npcs.map(o => [o.id, `${o.name || o.id}`]), { empty: 'Nobody', onChange: v => w(() => { S().speaker = v; }) }), npcs.length ? '' : 'Add a Character from the library to give the lines a speaker.'),
            field('Opens looking at', refInput(s.face, { onChange: v => w(() => { S().face = v; }) }))),
        field('Saved flags it starts with', linesInput(Object.entries(s.flags || {}).map(([k, v]) => `${k} = ${v}`), {
            rows: 2, placeholder: 'caelTrust = 0',
            onChange: lines => w(() => { const f = {}; for (const l of lines) { const [k, v] = l.split('=').map(x => x.trim()); if (k) f[k] = isNaN(+v) ? v : +v; } S().flags = f; }),
        }), 'Kept on the device between scenes, e.g. how much Cael trusts the player.')));

    // Steps.
    root.append(h('h4.bar', 'Steps ', h('small', 'run top to bottom unless an ending says where to go')));
    const stepIds = s.steps.map(x => x.id);
    s.steps.forEach((st, i) => {
        const open = openSteps.has(i);
        const summary = [st.say?.[0], st.objective].filter(Boolean)[0] || '';
        const head = h('button.step-head', { type: 'button', 'aria-expanded': String(open), on: { click: () => { open ? openSteps.delete(i) : openSteps.add(i); redraw(); } } },
            h('span.num', String(i + 1)), h('b', st.id), h('span.sum', summary));
        const card = h('section.card.step' + (open ? '.open' : ''), head);
        if (open) {
            const body = h('div.step-body');
            const move = d => w(() => { const a = S().steps; const [x] = a.splice(i, 1); a.splice(i + d, 0, x); openSteps = new Set([i + d]); }, true);
            body.append(h('div.row.tools',
                h('button.btn.small', { type: 'button', disabled: i === 0, on: { click: () => move(-1) } }, '↑ Up'),
                h('button.btn.small', { type: 'button', disabled: i === s.steps.length - 1, on: { click: () => move(1) } }, '↓ Down'),
                h('button.btn.small.danger', { type: 'button', on: { click: () => w(() => { S().steps.splice(i, 1); openSteps.clear(); }, true) } }, 'Delete step')));
            body.append(h('div.grid2',
                field('Step name', textInput(st.id, { onChange: v => w(() => { const old = st.id; st.id = v.trim() || old; for (const x of S().steps) for (const e of x.ends || []) if (e.next === old) e.next = st.id; }) })),
                field('Marks', refInput(st.mark, { onChange: v => w(() => { if (v) st.mark = v; else delete st.mark; }) }), 'An Earth ring over it; the speaker points.')));
            body.append(field('Lines when the step starts', linesInput(st.say, { rows: 3, onChange: v => w(() => { st.say = v; }) })));
            body.append(field('Objective', textInput(st.objective || '', { placeholder: 'Shown at the top. {held} shows the held-steady timer.', onChange: v => w(() => { if (v) st.objective = v; else delete st.objective; }) })));
            body.append(h('h5', 'When the step starts, also'), actionList(st.do ||= [], w, redraw));
            body.append(h('h5', 'While waiting ', h('small', 'each time this becomes true')));
            body.append(rowList(st.waiting ||= [], (wt, j) => h('div.card.sub',
                h('div.card-head', h('b', 'When'), xBtn('Remove', () => w(() => st.waiting.splice(j, 1), true))),
                condEditor(wt.when, c => w(() => { wt.when = c; }), redraw),
                field('Say', linesInput(wt.say, { rows: 1, onChange: v => w(() => { wt.say = v; }) })),
                h('h6', 'And do'), actionList(wt.do ||= [], w, redraw)),
            { add: () => w(() => st.waiting.push({ when: { time: 20 }, say: [], do: [] }), true), addLabel: 'reaction while waiting' }));
            body.append(h('h5', 'Endings ', h('small', 'the first that holds finishes the step')));
            body.append(rowList(st.ends ||= [], (e, j) => h('div.card.sub.ending',
                h('div.card-head', h('b', `Ending ${j + 1}`), xBtn('Remove ending', () => w(() => st.ends.splice(j, 1), true))),
                condEditor(e.when, c => w(() => { e.when = c; }), redraw),
                field('Say', linesInput(e.say, { rows: 2, onChange: v => w(() => { e.say = v; }) })),
                h('h6', 'And do'), actionList(e.do ||= [], w, redraw),
                h('div.grid2',
                    field('Then go to', select(e.next || '', [['', 'the next step'], ...stepIds.filter(x => x !== st.id).map(x => [x, x]), ['done', 'the end']], { onChange: v => w(() => { if (v) e.next = v; else delete e.next; }) })),
                    field('Outcome', textInput(e.outcome || '', { placeholder: 'e.g. quiet', onChange: v => w(() => { if (v) e.outcome = v; else delete e.outcome; }) }), 'The card and the save read it.'))),
            { add: () => w(() => st.ends.push({ when: { talking: false }, say: [], do: [] }), true), addLabel: 'ending' }));
            card.append(body);
        }
        root.append(card);
    });
    root.append(h('button.btn', {
        type: 'button', on: {
            click: () => w(() => {
                const ids = new Set(S().steps.map(x => x.id));
                let n = S().steps.length + 1; while (ids.has('step' + n)) n++;
                S().steps.push({ id: 'step' + n, say: [], ends: [{ when: { talking: false } }] });
                openSteps = new Set([S().steps.length - 1]);
            }, true),
        },
    }, '+ Add a step'));

    // Reactions.
    root.append(h('h4.bar', 'Reactions ', h('small', 'the speaker answers what the player does, at any point')));
    root.append(rowList(s.reactions, (r, i) => h('section.card',
        h('div.card-head', field('When', select(r.on, Object.entries(REACTION_EVENTS), { onChange: v => w(() => { r.on = v; }) })), xBtn('Remove reaction', () => w(() => S().reactions.splice(i, 1), true))),
        field('Lines: one set per time it happens, blank line between sets', (() => {
            const ta = h('textarea.lines', { rows: '4' });
            ta.value = (r.lines || []).map(set => set.join('\n')).join('\n\n');
            ta.addEventListener('change', () => w(() => { r.lines = ta.value.split(/\n\s*\n/).map(b => b.split('\n').map(x => x.trim()).filter(Boolean)).filter(b => b.length); }));
            return ta;
        })()),
        h('div.grid3',
            field('Quiet for (s)', numberInput(r.throttle || 0, { min: 0, max: 120, step: 1, onChange: v => w(() => { r.throttle = v; }) })),
            field('Cycle the sets', toggle(!!r.cycle, { onChange: v => w(() => { if (v) r.cycle = true; else delete r.cycle; }) })),
            field('Count as', textInput(r.count || '', { placeholder: 'counter', onChange: v => w(() => { if (v) r.count = v; else delete r.count; }) }))),
        h('div.grid2',
            field('Change flag', textInput(r.flag?.name || '', { placeholder: 'e.g. caelTrust', onChange: v => w(() => { if (v) r.flag = { name: v, add: r.flag?.add ?? -1 }; else delete r.flag; }) })),
            field('By', numberInput(r.flag?.add ?? -1, { min: -10, max: 10, step: 1, onChange: v => w(() => { if (r.flag) r.flag.add = v; }) }))),
        r.followUp ? h('div.card.sub',
            h('div.card-head', h('b', 'Follow-up'), xBtn('Remove follow-up', () => w(() => { delete r.followUp; }, true))),
            h('div.grid2',
                field('After (s)', numberInput(r.followUp.after || 0, { min: 0, max: 60, step: 0.5, onChange: v => w(() => { r.followUp.after = v; }) })),
                field('First time only', toggle(!!r.followUp.firstOnly, { onChange: v => w(() => { r.followUp.firstOnly = v; }) }))),
            h('h6', 'Only if'), condEditor(r.followUp.if || { burning: true }, c => w(() => { r.followUp.if = c; }), redraw),
            field('Say', linesInput(r.followUp.say, { rows: 1, onChange: v => w(() => { r.followUp.say = v; }) })))
            : h('button.btn.small', { type: 'button', on: { click: () => w(() => { r.followUp = { after: 4, firstOnly: true, if: { burning: true }, say: [] }; }, true) } }, '+ Follow-up line')),
    { add: () => w(() => S().reactions.push({ on: 'playerFire', lines: [[]], throttle: 10 }), true), addLabel: 'reaction' }));

    // The card.
    const card = s.card ||= { title: '', lines: [], buttons: [] };
    root.append(h('h4.bar', 'End card ', h('small', 'shown by a Show the end card action')));
    root.append(h('section.card',
        field('Title', textInput(card.title, { onChange: v => w(() => { card.title = v; }) })),
        field('Lines', linesInput(card.lines, { rows: 4, onChange: v => w(() => { card.lines = v; }) }),
            '{outcome|quiet=…|loud=…} picks by outcome · {fireSeen|0=…|*=# times} by a counter · {earth.power} a level'),
        field('Buttons: Label | link, one per row', linesInput((card.buttons || []).map(b => `${b.label} | ${b.href}`), {
            rows: 2, onChange: v => w(() => { card.buttons = v.map(l => { const [label, href] = l.split('|').map(x => x.trim()); return { label, href: href || '' }; }).filter(b => b.label); }),
        }))));

    root.append(h('div.acts', h('button.btn.danger', {
        type: 'button', on: {
            click: async () => {
                if (!await ask('Remove the story?', 'Its steps, reactions and card go. Undo brings them back.', 'Remove', 'Keep it', true)) return;
                w(() => { doc.scene.script = null; }, true);
            },
        },
    }, 'Remove the story')));
}

// ==== SCENE (settings + every object) =====================================================================

let filterText = '';
export function scenePanel(root, api) {
    const redraw = () => scenePanel(root, api);
    root.replaceChildren();
    const sc = doc.scene, st = sc.settings;
    st.ground ||= { half: 20, style: 'grass' };
    const w = (fn, what = 'settings', again = false) => { edit(fn, what, again); if (again) redraw(); };
    root.append(h('section.sec',
        h('div.grid2',
            field('Scene name', textInput(sc.name, { onChange: v => w(() => { sc.name = v; }) })),
            field('File name', textInput(sc.id, { onChange: v => { const id = v.trim().replace(/[^\w-]/g, '-'); if (!id) return; w(() => { sc.id = id; }); } }), `Plays in the game at ?scene=${sc.id}`)),
        h('div.grid2',
            field('Ground', select(st.ground.style, GROUND_STYLES, { onChange: v => w(() => { st.ground.style = v; }) })),
            field('Ground size (m from centre)', numberInput(st.ground.half, { min: 6, max: 120, step: 2, onChange: v => w(() => { st.ground.half = v; }) }))),
        h('div.grid2',
            field('Powers', seg(st.profile || 'sandbox', [['story', 'The story’s'], ['sandbox', 'Everything']], { onChange: v => w(() => { st.profile = v; }) }), 'Story: what the player has learned so far. Everything: all four elements, fully trained.'),
            field('Start the story over', toggle(!!st.resetProgress, { onChange: v => w(() => { st.resetProgress = v; }) }), 'On for the first scene of the story.')),
        h('div.grid2',
            field('Kingdom', select(st.region || 'verdant', Object.entries(REGION_NAMES), { onChange: v => w(() => { st.region = v; }) }), 'What the player does here counts with this kingdom.'),
            field('Remembers what happens', toggle(!!st.persistent, { onChange: v => w(() => { st.persistent = v; }) }), 'Burned, broken and revealed things stay that way in the save.')),
        field('Put disturbed props back after (s, 0 = never)', numberInput(st.resetAfter || 0, { min: 0, max: 600, step: 5, onChange: v => w(() => { st.resetAfter = v; }) }), 'A testing aid.')));

    root.append(h('h4.bar', `Everything in the scene `, h('small', `${sc.objects.length} objects`)));
    const q = textInput(filterText, { placeholder: 'Find by name or kind', live: true, onChange: v => { filterText = v; list(); } });
    const out = h('div.outline');
    const list = () => {
        const f = filterText.toLowerCase();
        out.replaceChildren();
        for (const g of GROUPS) {
            const items = sc.objects.filter(o => TYPES[o.type]?.group === g && (!f || o.id.toLowerCase().includes(f) || typeLabel(o.type).toLowerCase().includes(f)));
            if (!items.length) continue;
            out.append(h('h5', g, h('small', ` ${items.length}`)));
            for (const o of items) {
                out.append(h('button.oitem' + (o.id === doc.sel ? '.on' : ''), {
                    type: 'button', on: { click: () => { selectObj(o.id); api.view.frame(o.id); api.tab('inspect'); } },
                }, h('b', o.id), h('span', typeLabel(o.type) + (o.hidden ? ' · hidden' : '') + (o.type === 'prefab' ? ` · ${PREFABS[o.prefab]?.label}` : ''))));
            }
        }
        if (!out.children.length) out.append(h('p.empty', 'Nothing matches.'));
    };
    list();
    root.append(q, out);
}

// ==== CHECK =============================================================================================

export function checkPanel(root, api, problems) {
    root.replaceChildren();
    const errs = problems.filter(p => p.level === 'error'), warns = problems.filter(p => p.level === 'warn');
    if (!problems.length) {
        root.append(h('div.empty-state.good', h('h3', 'Ready for the game'), h('p', 'The game’s own checks find nothing wrong with this scene.')));
        return;
    }
    root.append(h('p.lede', errs.length ? `${errs.length} problem${errs.length > 1 ? 's' : ''} would break the game. ` : '', warns.length ? `${warns.length} thing${warns.length > 1 ? 's' : ''} look${warns.length > 1 ? '' : 's'} like a mistake.` : ''));
    for (const p of [...errs, ...warns]) {
        const target = byId(p.where) ? p.where : null;
        root.append(h('button.problem.' + p.level, {
            type: 'button', disabled: !target && !/^(wire|step|script)/.test(p.where),
            on: {
                click: () => {
                    if (target) { selectObj(target); api.view.frame(target); api.tab('inspect'); }
                    else if (p.where.startsWith('wire')) api.tab('logic');
                    else api.tab('story');
                },
            },
        }, h('b', p.level === 'error' ? 'Error' : 'Check'), h('span', h('i', p.where), ' ', p.msg)));
    }
}

export { fmt };
