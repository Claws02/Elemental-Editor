// ============================================================
// STORE — "Save for Claude": scenes kept in the page's database
// ============================================================
//
//   scenes/<id>                     the latest save: { scene, note, savedAt, game, name, objects }
//   scenes/<id>/versions/<stamp>    every save, newest 30 kept
//
// Claude reads scenes/<id> and writes it into the game's scenes/ folder.
// When the page runs where the database isn't available, saving says so and
// the work stays on the device.
// ============================================================

let db = null;
let ready = null;
const KEEP = 30;

export function initStore() {
    ready ||= (async () => {
        try { db = (await window.claude?.use?.('db')) || null; } catch (e) { db = null; }
        return !!db;
    })();
    return ready;
}
export const hasStore = () => !!db;

const stamp = iso => iso.replace(/[^0-9]/g, '').slice(0, 17);

export async function saveScene(scene, note, game) {
    if (!db) throw new Error('Saving for Claude isn’t available in this view.');
    const savedAt = new Date().toISOString();
    const body = { scene, note: note || '', savedAt, game: game || '', name: scene.name || scene.id, objects: scene.objects.length };
    await db.doc(`scenes/${scene.id}`).set(body);
    await db.collection(`scenes/${scene.id}/versions`).doc(stamp(savedAt)).set(body);
    try {
        const all = await db.collection(`scenes/${scene.id}/versions`).orderBy('savedAt', 'desc').get();
        for (const d of all.docs.slice(KEEP)) await db.doc(`scenes/${scene.id}/versions/${d.id}`).delete();
    } catch (e) { /* pruning can wait for the next save */ }
    return savedAt;
}

/** Every saved scene: [{ id, name, savedAt, note, objects }] newest first. */
export async function listSaved() {
    if (!db) return [];
    const snap = await db.collection('scenes').get();
    return snap.docs.map(d => ({ id: d.id, ...pick(d.data()) })).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
}

export async function loadSaved(id) {
    if (!db) return null;
    const d = await db.doc(`scenes/${id}`).get();
    return d.exists ? d.data() : null;
}

export async function listVersions(id) {
    if (!db) return [];
    const snap = await db.collection(`scenes/${id}/versions`).orderBy('savedAt', 'desc').limit(KEEP).get();
    return snap.docs.map(d => ({ key: d.id, ...d.data() }));
}

const pick = d => ({ name: d.name, savedAt: d.savedAt, note: d.note, objects: d.objects });
