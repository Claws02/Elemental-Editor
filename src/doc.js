// ============================================================
// DOC — the scene being edited, its selection, undo and the device copy
// ============================================================
//
// One scene at a time, in the game's own format (game/src/scene/schema.js).
// Every change goes through here: `checkpoint()` before it (for undo),
// `changed(what)` after it (panels and the view redraw what they show).
//
//   what: 'all' (a new scene), 'objects', 'object:<id>', 'wires', 'script',
//         'settings', 'selection'
// ============================================================

import { TYPES, defaults } from '../game/src/scene/schema.js';

const LOCAL_KEY = 'elemental-editor.work.v1';
const MAX_UNDO = 120;

export const doc = {
    scene: null,
    sel: null,              // selected object id (the one the inspector shows)
    multi: [],              // and the others selected with it (Select several)
    saved: '',              // JSON of the scene as last saved for Claude (for "unsaved changes")
    savedAt: null,
    source: '',             // where it came from: 'game', 'saved', 'new', 'device'
};

const subs = new Set();
const undoStack = [], redoStack = [];

export function on(fn) { subs.add(fn); return () => subs.delete(fn); }
export function changed(what = 'all') {
    for (const fn of subs) { try { fn(what); } catch (e) { console.error(e); } }
    if (what !== 'selection') _keepLocal();
}

// ---- loading ---------------------------------------------------------------------------

export function load(scene, { source = 'game', saved = null, savedAt = null } = {}) {
    doc.scene = JSON.parse(JSON.stringify(scene));
    doc.scene.objects ||= [];
    doc.scene.wires ||= [];
    doc.scene.settings ||= { ground: { half: 20, style: 'grass' }, profile: 'sandbox' };
    if (doc.scene.script) normalizeScript(doc.scene.script);
    doc.sel = null;
    doc.multi = [];
    doc.source = source;
    doc.saved = saved ?? '';
    doc.savedAt = savedAt;
    undoStack.length = redoStack.length = 0;
    changed('all');
}

/** Steps written as until/then become one ending each: the editor edits `ends`. */
export function normalizeScript(s) {
    s.steps ||= [];
    s.reactions ||= [];
    for (const st of s.steps) {
        if (st.until) {
            st.ends = [{ when: st.until, ...(st.then || {}) }, ...(st.ends || [])];
            delete st.until; delete st.then;
        }
        st.ends ||= [];
    }
    return s;
}

export const json = () => JSON.stringify(doc.scene);
export const dirty = () => json() !== doc.saved;

// ---- undo --------------------------------------------------------------------------------

export function checkpoint() {
    undoStack.push(JSON.stringify({ scene: doc.scene, sel: doc.sel }));
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
}
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export function undo() { _swap(undoStack, redoStack); }
export function redo() { _swap(redoStack, undoStack); }
function _swap(from, to) {
    if (!from.length) return;
    to.push(JSON.stringify({ scene: doc.scene, sel: doc.sel }));
    const s = JSON.parse(from.pop());
    doc.scene = s.scene;
    doc.sel = s.sel && byId(s.sel) ? s.sel : null;
    doc.multi = doc.multi.filter(id => byId(id) && id !== doc.sel);
    changed('all');
}

// ---- objects --------------------------------------------------------------------------------

export const byId = id => doc.scene.objects.find(o => o.id === id) || null;
export const selected = () => (doc.sel ? byId(doc.sel) : null);

export function select(id) {
    if (doc.sel === id && !doc.multi.length) return;
    doc.sel = id;
    doc.multi = [];
    changed('selection');
}

/** Everything selected: the inspected one first. */
export const selection = () => (doc.sel ? [doc.sel, ...doc.multi] : [...doc.multi]);
export const isSelected = id => doc.sel === id || doc.multi.includes(id);

/** Select several: add `id`, or take it out if it's in. */
export function toggleSelect(id) {
    if (isSelected(id)) {
        if (doc.sel === id) { doc.sel = doc.multi.shift() || null; }
        else doc.multi = doc.multi.filter(x => x !== id);
    } else if (!doc.sel) doc.sel = id;
    else doc.multi.push(id);
    changed('selection');
}

/** Select exactly these (a box drawn in the view). */
export function selectMany(ids, add = false) {
    const all = [...new Set([...(add ? selection() : []), ...ids])];
    doc.sel = all[0] || null;
    doc.multi = all.slice(1);
    changed('selection');
}

/** Duplicate everything selected, the copies selected after. */
export function duplicateMany(ids) {
    const src = ids.map(byId).filter(o => o && !TYPES[o.type]?.single);
    if (!src.length) return [];
    checkpoint();
    const made = src.map(o => {
        const c = JSON.parse(JSON.stringify(o));
        c.id = uniqueId(o.id);
        c.x = round(o.x + 1.5); c.z = round(o.z + 1.5);
        doc.scene.objects.push(c);
        return c.id;
    });
    doc.sel = made[0]; doc.multi = made.slice(1);
    changed('objects');
    changed('selection');
    return made;
}

/** Delete everything selected, in one undo. */
export function removeMany(ids) {
    const gone = new Set(ids);
    if (!gone.size) return;
    checkpoint();
    doc.scene.objects = doc.scene.objects.filter(o => !gone.has(o.id));
    doc.sel = null; doc.multi = [];
    changed('objects');
    changed('selection');
}

/** A fresh id from a base: Rock → Rock_03. */
export function uniqueId(base) {
    base = String(base).replace(/[^\w-]/g, '_').replace(/_\d+$/, '') || 'Object';
    const taken = new Set(doc.scene.objects.map(o => o.id));
    for (const o of doc.scene.objects) if (o.type === 'prefab') for (let i = 1; i < 40; i++) taken.add(`${o.id}.${i}`);
    for (let n = 1; ; n++) {
        const id = `${base}_${String(n).padStart(2, '0')}`;
        if (!taken.has(id)) return id;
    }
}

const ID_BASE = { b_wall: 'Wall', b_floor: 'Floor', b_roof: 'Roof', b_stairs: 'Stairs', b_fence: 'Fence', b_post: 'Post', ruin_wall: 'RuinWall', sealed_door: 'SealedDoor', npc: 'Character', prefab: 'Building', spawn: 'Spawn' };

export function addObject(type, at, extra = {}) {
    const t = TYPES[type];
    if (t.single && doc.scene.objects.some(o => o.type === type)) {
        const o = doc.scene.objects.find(o => o.type === type);
        checkpoint();
        Object.assign(o, { x: round(at.x), z: round(at.z) });
        doc.sel = o.id;
        changed('object:' + o.id);
        changed('selection');
        return o;
    }
    checkpoint();
    const base = ID_BASE[type] || type.charAt(0).toUpperCase() + type.slice(1);
    const o = { id: uniqueId(base), type, x: round(at.x), y: 0, z: round(at.z), rotY: 0, ...defaults(type), ...extra };
    if ('hidden' in o && !o.hidden) delete o.hidden;
    if (type === 'npc') o.name = o.id.replace(/_\d+$/, '') === 'Character' ? 'Villager' : o.name;
    doc.scene.objects.push(o);
    doc.sel = o.id;
    doc.multi = [];
    changed('objects');
    changed('selection');
    return o;
}

export function duplicate(id) {
    const o = byId(id);
    if (!o || TYPES[o.type]?.single) return null;
    checkpoint();
    const c = JSON.parse(JSON.stringify(o));
    c.id = uniqueId(o.id);
    c.x = round(o.x + 1.5); c.z = round(o.z + 1.5);
    doc.scene.objects.push(c);
    doc.sel = c.id;
    changed('objects');
    changed('selection');
    return c;
}

export function remove(id) {
    const i = doc.scene.objects.findIndex(o => o.id === id);
    if (i < 0) return;
    checkpoint();
    doc.scene.objects.splice(i, 1);
    if (doc.sel === id) doc.sel = null;
    doc.multi = doc.multi.filter(x => x !== id);
    changed('objects');
    changed('selection');
}

/** Rename an object, and every reference to it (wires, script, chains). */
export function rename(oldId, newId) {
    newId = String(newId).trim().replace(/[^\w.-]/g, '_');
    if (!newId || newId === oldId) return false;
    if (byId(newId)) return false;
    checkpoint();
    byId(oldId).id = newId;
    replaceRefs(doc.scene, oldId, newId);
    if (doc.sel === oldId) doc.sel = newId;
    doc.multi = doc.multi.map(x => (x === oldId ? newId : x));
    changed('all');
    return true;
}

const REF_KEYS = new Set(['obj', 'mark', 'speaker', 'face', 'held', 'chainTo', 'reveal', 'hide']);
function replaceRefs(node, a, b, key = '') {
    if (Array.isArray(node)) {
        node.forEach((v, i) => {
            if (typeof v === 'string' && REF_KEYS.has(key) && v === a) node[i] = b;
            else replaceRefs(v, a, b, key);
        });
    } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
            if (typeof v === 'string' && REF_KEYS.has(k) && v === a) node[k] = b;
            else replaceRefs(v, a, b, k);
        }
    }
}

/** Where an id is used (for the inspector: "used by wire Gate, step trial"). */
export function usesOf(id) {
    const out = [];
    const walk = (node, where, key = '') => {
        if (Array.isArray(node)) node.forEach(v => (typeof v === 'string' ? (REF_KEYS.has(key) && v === id && out.push(where)) : walk(v, where, key)));
        else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) {
            if (typeof v === 'string') { if (REF_KEYS.has(k) && v === id) out.push(where); }
            else walk(v, where, k);
        }
    };
    for (const w of doc.scene.wires) walk(w, `wire “${w.id}”`);
    const s = doc.scene.script;
    if (s) {
        if (s.speaker === id) out.push('the story’s speaker');
        if (s.face === id) out.push('the story’s opening view');
        for (const st of s.steps) walk(st, `step “${st.id}”`);
    }
    for (const o of doc.scene.objects) if (o.chainTo === id) out.push(`${o.id}’s chain`);
    return [...new Set(out)];
}

export const round = (v, step = 0.05) => Math.round(v / step) * step;

// ---- the device copy ----------------------------------------------------------------------------

let _localT = 0;
function _keepLocal() {
    clearTimeout(_localT);
    _localT = setTimeout(() => {
        try { localStorage.setItem(LOCAL_KEY, JSON.stringify({ scene: doc.scene, saved: doc.saved, savedAt: doc.savedAt, source: doc.source })); } catch (e) { /* storage refused: work stays in memory */ }
    }, 400);
}

export function readLocal() {
    try { const s = JSON.parse(localStorage.getItem(LOCAL_KEY)); return s?.scene ? s : null; } catch (e) { return null; }
}
