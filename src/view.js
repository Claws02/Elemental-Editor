// ============================================================
// VIEW — the scene drawn with the game's own models, and the touches on it
// ============================================================
//
// Two cameras: PLAN (straight down, north up) for laying out, and 3D (orbit)
// for heights, roofs and how it will look. Every object is drawn with the
// game's Catalog.modelOf(), so what is placed is what ships.
//
// Touch (iPad first; a mouse does the same):
//   one finger on a thing    select it and drag it across the ground
//   the gold handle          turn it (the handle marks its front)
//   one finger on nothing    pan (plan) or orbit (3D); a tap clears the selection
//   two fingers              pinch to zoom, drag to pan
//   mouse wheel · right-drag  zoom · pan
//
// Select several (the bar's toggle): a tap adds or takes out, a drag on
// nothing draws a box round what to select, a drag on one moves them all.
// A land brush (Land tab): one finger sculpts or paints the terrain.
// A patrolling character's route shows as gold points: drag them.
// ============================================================

import { THREE } from '../game/src/engine/lib.js';
import { modelOf, withDefaults, expandPrefab, CATALOG, parseRoute } from '../game/src/scene/Catalog.js';
import { Terrain, decodeTerrain, encodeTerrain, SURFACE_INDEX } from '../game/src/world/Terrain.js';
import { flagstoneFloor } from '../game/src/art/PropModels.js';
import { groundBase } from '../game/src/art/TownModels.js';
import { doc, changed, checkpoint, select, byId, selection, isSelected, toggleSelect, selectMany } from './doc.js';

const ROUTE_PX = 22;      // how close a finger must be to grab a route point

const SNAP = 0.5, SNAP_ANGLE = Math.PI / 12;
const TAP_PX = 7;

export class View {
    constructor(canvas, { onPick } = {}) {
        this.canvas = canvas;
        this.onPick = onPick;
        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
        this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = 1.05;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x2b2721);
        this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x5a4a38, 0.8 * Math.PI));
        const sun = this.sun = new THREE.DirectionalLight(0xffe2b8, 1.8 * Math.PI);
        sun.position.set(24, 40, 18);
        sun.castShadow = true;
        sun.shadow.mapSize.set(2048, 2048);
        sun.shadow.bias = -0.0006;
        sun.shadow.normalBias = 0.03;
        this.scene.add(sun, sun.target);

        this.world = new THREE.Group();        // the objects
        this.overlay = new THREE.Group();      // selection, handle, wires, hidden marks
        this.scene.add(this.world, this.overlay);
        this.models = new Map();               // id → { root, key }
        this.groundKey = '';

        this.persp = new THREE.PerspectiveCamera(50, 1, 0.1, 600);
        this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -200, 400);
        this.mode = 'plan';
        this.plan = { cx: 0, cz: 0, ppm: 14 };                 // pixels per metre
        this.orbit = { tx: 0, ty: 0, tz: 0, yaw: 0.5, pitch: 0.75, dist: 38 };
        this.snap = true;
        this.show = { wires: true, hidden: true, grid: true };
        this.problems = new Set();             // ids with errors: outlined red
        this.multi = false;                    // Select several
        this.brush = null;                     // { kind: raise|lower|smooth|flatten|paint, size, strength, surface }
        this.terrain = null;                   // the game's Terrain, drawn (settings.terrain)
        this.terrainKey = '';
        this._cursor();
        this._boxDiv();

        this.sun.castShadow = false;             // plan first
        this._handle();
        this._gestures();
        new ResizeObserver(() => this.resize()).observe(canvas.parentElement);
        this.resize();
        this.needs = true;
        this.paused = false;
        const loop = () => { if (this.needs && !this.paused) { this.needs = false; this._render(); } requestAnimationFrame(loop); };
        requestAnimationFrame(loop);
    }

    get camera() { return this.mode === 'plan' ? this.ortho : this.persp; }
    redraw() { this.needs = true; }

    setMode(m) {
        this.mode = m;
        this.sun.castShadow = m !== 'plan';       // straight down, shadows only clutter the layout
        this._cams();
        this.redraw();
    }

    resize() {
        const p = this.canvas.parentElement;
        const w = Math.max(1, p.clientWidth), hh = Math.max(1, p.clientHeight);
        this.renderer.setSize(w, hh, false);
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = hh + 'px';
        this.w = w; this.h = hh;
        this._cams();
        this.redraw();
    }

    _cams() {
        const { w, h } = this;
        const p = this.plan;
        Object.assign(this.ortho, { left: -w / 2 / p.ppm, right: w / 2 / p.ppm, top: h / 2 / p.ppm, bottom: -h / 2 / p.ppm });
        this.ortho.position.set(p.cx, 150, p.cz);
        this.ortho.up.set(0, 0, -1);
        this.ortho.lookAt(p.cx, 0, p.cz);
        this.ortho.updateProjectionMatrix();
        const o = this.orbit;
        o.pitch = Math.max(0.08, Math.min(1.5, o.pitch));
        o.dist = Math.max(3, Math.min(220, o.dist));
        this.persp.aspect = w / h;
        this.persp.position.set(o.tx + Math.sin(o.yaw) * Math.cos(o.pitch) * o.dist, o.ty + Math.sin(o.pitch) * o.dist, o.tz + Math.cos(o.yaw) * Math.cos(o.pitch) * o.dist);
        this.persp.lookAt(o.tx, o.ty, o.tz);
        this.persp.updateProjectionMatrix();
    }

    /** Where new things go: the middle of the view, on the ground. */
    centre() {
        if (this.mode === 'plan') return { x: this.plan.cx, z: this.plan.cz };
        return { x: this.orbit.tx, z: this.orbit.tz };
    }

    /** Frame the whole scene (or one object). */
    frame(id = null) {
        const box = new THREE.Box3();
        if (id && this.models.get(id)) box.setFromObject(this.models.get(id).root);
        else for (const m of this.models.values()) if (m.root.visible) box.expandByObject(m.root);
        if (box.isEmpty()) { const g = this.terrain ? this.terrain.half : doc.scene.settings?.ground?.half || 20; box.set(new THREE.Vector3(-g, 0, -g), new THREE.Vector3(g, 2, g)); }
        const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
        const span = Math.max(s.x, s.z, 4) * 1.15;
        this.plan.cx = c.x; this.plan.cz = c.z;
        this.plan.ppm = Math.max(2, Math.min(120, Math.min(this.w, this.h) / span));
        Object.assign(this.orbit, { tx: c.x, ty: this.groundY(c.x, c.z), tz: c.z, dist: Math.max(8, span * 1.1) });
        this._cams();
        this.redraw();
    }

    // ---- the scene -------------------------------------------------------------------------

    /** Bring the drawn scene in line with doc.scene. */
    sync(what = 'all') {
        const scene = doc.scene;
        if (!scene) return;
        if (what === 'selection' || what === 'problems' || what === 'overlay') { this._overlay(); this.redraw(); return; }
        this._syncTerrain(scene.settings?.terrain || null);
        const g = scene.settings?.ground || { half: 20, style: 'grass' };
        const gk = this.terrain ? 'terrain' : g.half + g.style;
        if (gk !== this.groundKey && this.terrain) {
            this.groundKey = gk;
            if (this.ground) { this.scene.remove(this.ground); this._dispose(this.ground); this.ground = null; }
            if (this.grid) { this.scene.remove(this.grid); this.grid = null; }
            const S = 70;
            Object.assign(this.sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 260 });
            this.sun.shadow.camera.updateProjectionMatrix();
        }
        if (gk !== this.groundKey) {
            this.groundKey = gk;
            if (this.ground) { this.scene.remove(this.ground); this._dispose(this.ground); }
            this.ground = g.style === 'flagstone' ? flagstoneFloor(g.half) : groundBase(g.half, g.style);
            this.ground.traverse(o => { o.receiveShadow = true; });
            this.scene.add(this.ground);
            if (this.grid) this.scene.remove(this.grid);
            this.grid = new THREE.GridHelper(g.half * 2, g.half * 2 / 2, 0xffffff, 0xffffff);
            this.grid.material.transparent = true;
            this.grid.material.opacity = 0.09;
            this.grid.material.depthWrite = false;
            this.grid.position.y = 0.08;
            this.scene.add(this.grid);
            const S = g.half + 4;
            Object.assign(this.sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 1, far: 140 });
            this.sun.shadow.camera.updateProjectionMatrix();
        }
        if (what.startsWith?.('object:')) this._syncOne(byId(what.slice(7)));
        else {
            const seen = new Set();
            for (const o of scene.objects) { seen.add(o.id); this._syncOne(o); }
            for (const [id, m] of this.models) if (!seen.has(id)) { this.world.remove(m.root); this._dispose(m.root); this.models.delete(id); }
        }
        this._overlay();
        this.redraw();
    }

    // ---- terrain -----------------------------------------------------------------------------------

    /** Ground height at (x, z): the terrain's, or 0 on a flat scene. */
    groundY(x, z) { return this.terrain ? this.terrain.height(x, z) : 0; }

    _syncTerrain(t) {
        const key = t ? `${t.size}/${t.cell}/${t.heights}/${t.paint}` : '';
        if (key === this.terrainKey) return;
        this.terrainKey = key;
        if (this.terrain) { this.terrain.dispose(); this.terrain = null; }
        if (!t) return;
        this.terrain = new Terrain(decodeTerrain(t)).build(this.scene, { physics: false });
        this.terrain.group.traverse(m => { m.receiveShadow = true; });
    }

    /** One dab of the land brush at (x, z). */
    _dab(x, z, stroke) {
        const T = this.terrain, b = this.brush;
        if (!T || !b) return;
        const R = b.size / 2, k = b.strength;
        const [gx, gz] = T.grid(x, z), rc = R / T.cell;
        const i0 = Math.max(0, Math.floor(gx - rc)), i1 = Math.min(T.n - 1, Math.ceil(gx + rc));
        const j0 = Math.max(0, Math.floor(gz - rc)), j1 = Math.min(T.n - 1, Math.ceil(gz + rc));
        const old = b.kind === 'smooth' ? T.h.slice() : null;
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
            const px = -T.half + i * T.cell, pz = -T.half + j * T.cell, d = Math.hypot(px - x, pz - z);
            if (d > R) continue;
            const w = 1 - (d / R) ** 2 * (3 - 2 * d / R);          // smooth falloff to the rim
            const q = T.idx(i, j);
            if (b.kind === 'raise') T.h[q] += 0.35 * k * w;
            else if (b.kind === 'lower') T.h[q] -= 0.35 * k * w;
            else if (b.kind === 'flatten') T.h[q] += (stroke.level - T.h[q]) * Math.min(1, 0.5 * k * w);
            else if (b.kind === 'smooth' && i > 0 && j > 0 && i < T.n - 1 && j < T.n - 1) {
                const avg = (old[q - 1] + old[q + 1] + old[q - T.n] + old[q + T.n]) / 4;
                T.h[q] += (avg - old[q]) * Math.min(1, k * w);
            } else if (b.kind === 'paint' && d <= R * 0.9) T.p[q] = SURFACE_INDEX[b.surface] ?? T.p[q];
        }
        T.rebuild(i0, j0, i1, j1);
        // Things standing there follow the ground.
        for (const o of doc.scene.objects) if (Math.abs(o.x - x) < R + 12 && Math.abs(o.z - z) < R + 12) this._syncOne(o);
        stroke.touched = true;
        this.redraw();
    }

    /** The stroke is done: the land goes back into the scene file (one undo for the stroke). */
    _endStroke() {
        const T = this.terrain;
        const t = encodeTerrain(T);
        doc.scene.settings.terrain = t;
        this.terrainKey = `${t.size}/${t.cell}/${t.heights}/${t.paint}`;
        changed('settings');
    }

    _cursor() {
        const g = new THREE.BufferGeometry().setFromPoints(Array.from({ length: 49 }, () => new THREE.Vector3()));
        this.ring = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xffb347, depthTest: false, transparent: true }));
        this.ring.renderOrder = 12;
        this.ring.visible = false;
        this.scene.add(this.ring);
    }

    _ringAt(p) {
        if (!p || !this.brush || !this.terrain) { this.ring.visible = false; this.redraw(); return; }
        const pos = this.ring.geometry.attributes.position, R = this.brush.size / 2;
        for (let k = 0; k <= 48; k++) {
            const a = (k / 48) * Math.PI * 2, x = p.x + Math.cos(a) * R, z = p.z + Math.sin(a) * R;
            pos.setXYZ(k, x, this.terrain.height(x, z) + 0.15, z);
        }
        pos.needsUpdate = true;
        this.ring.geometry.computeBoundingSphere();
        this.ring.visible = true;
        this.redraw();
    }

    setBrush(b) { this.brush = b; if (!b) this.ring.visible = false; this.redraw(); }

    // ---- selecting several by a box ---------------------------------------------------------------

    _boxDiv() {
        const d = this.boxEl = document.createElement('div');
        d.className = 'selbox';
        Object.assign(d.style, { position: 'fixed', border: '1.5px dashed #ffb347', background: 'rgba(255,179,71,0.08)', pointerEvents: 'none', display: 'none', zIndex: 5 });
        document.body.append(d);
    }

    _boxSelect(g, x, y, done) {
        const l = Math.min(g.sx, x), r = Math.max(g.sx, x), t = Math.min(g.sy, y), b = Math.max(g.sy, y);
        if (!done) { Object.assign(this.boxEl.style, { display: 'block', left: l + 'px', top: t + 'px', width: r - l + 'px', height: b - t + 'px' }); return; }
        this.boxEl.style.display = 'none';
        const ids = doc.scene.objects.filter(o => {
            const s = this._screen(new THREE.Vector3(o.x, this.groundY(o.x, o.z) + (o.y || 0), o.z));
            return s.x >= l && s.x <= r && s.y >= t && s.y <= b;
        }).map(o => o.id);
        selectMany(ids, true);
    }

    // ---- a patrol route ------------------------------------------------------------------------------

    /** The selected character's route points (or null). */
    route() {
        const o = doc.sel && byId(doc.sel);
        return o?.type === 'npc' && o.role === 'patrol' ? parseRoute(o.route) : null;
    }

    _syncOne(o) {
        if (!o) return;
        const { id, x, y, z, rotY, ...rest } = o;
        const key = JSON.stringify(rest);
        let m = this.models.get(id);
        if (!m || m.key !== key) {
            if (m) { this.world.remove(m.root); this._dispose(m.root); }
            let root;
            try { root = modelOf(o); }
            catch (e) { console.warn(e); root = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xff00ff, wireframe: true })); }
            root.traverse(c => { c.userData.sceneId = id; if (c.isMesh && !c.material?.transparent) { c.castShadow = true; c.receiveShadow = true; } });
            const holder = new THREE.Group();
            holder.add(root);
            holder.userData.sceneId = id;
            m = { root: holder, key };
            this.models.set(id, m);
            this.world.add(holder);
        }
        const base = CATALOG[o.type]?.absolute ? (o.level ?? 0) : this.groundY(x || 0, z || 0);      // on terrain, y is above the ground (water: its level)
        m.root.position.set(x || 0, base + (y || 0), z || 0);
        m.root.rotation.y = rotY || 0;
        m.root.updateMatrixWorld(true);
    }

    _dispose(root) { root.traverse(o => { o.geometry?.dispose?.(); }); }

    // ---- overlay: selection, handle, wires, hidden things, problems --------------------------------

    _handle() {
        const mat = new THREE.MeshBasicMaterial({ color: 0xffb347, depthTest: false, transparent: true });
        this.handle = new THREE.Group();
        const knob = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), mat);
        const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 1, 6), mat);
        stem.rotation.x = Math.PI / 2;
        this.handle.add(knob, stem);
        this.handle.knob = knob;
        this.handle.stem = stem;
        this.handle.renderOrder = 10;
        knob.renderOrder = stem.renderOrder = 10;
        this.handle.visible = false;
        this.scene.add(this.handle);
    }

    _boxOf(id) {
        const m = this.models.get(id);
        if (!m) return null;
        const b = new THREE.Box3().setFromObject(m.root);
        return b.isEmpty() ? null : b;
    }

    _overlay() {
        for (const c of [...this.overlay.children]) { this.overlay.remove(c); c.geometry?.dispose(); }
        const add = (box, color, opacity = 1) => {
            const hlp = new THREE.Box3Helper(box, color);
            hlp.material.transparent = true;
            hlp.material.opacity = opacity;
            hlp.material.depthTest = false;
            hlp.renderOrder = 5;
            this.overlay.add(hlp);
        };
        const objs = doc.scene.objects;
        if (this.show.hidden) for (const o of objs) if (o.hidden) { const b = this._boxOf(o.id); if (b) add(b, 0x4fd6ff, 0.8); }
        for (const id of this.problems) { const b = this._boxOf(id); if (b) add(b, 0xff5a4a, 0.9); }
        if (this.show.wires) {
            const pts = [], cols = [];
            const centre = id => { const b = this._boxOf(id); return b ? b.getCenter(new THREE.Vector3()).setY(Math.max(0.6, b.max.y * 0.6)) : null; };
            const link = (a, b, col) => {
                const p = centre(a), q = centre(b);
                if (!p || !q) return;
                pts.push(p, q);
                const c = new THREE.Color(col);
                cols.push(c.r, c.g, c.b, c.r, c.g, c.b);
            };
            for (const w of doc.scene.wires || []) for (const i of w.inputs || []) for (const a of [...(w.do || []), ...(w.undo || [])]) link(i.obj, a.obj, 0x4fd6ff);
            for (const o of objs) if (o.chainTo) link(o.id, o.chainTo, 0xb8bcc0);
            if (pts.length) {
                const g = new THREE.BufferGeometry().setFromPoints(pts);
                g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
                const l = new THREE.LineSegments(g, new THREE.LineDashedMaterial({ vertexColors: true, dashSize: 0.5, gapSize: 0.3, depthTest: false, transparent: true, opacity: 0.9 }));
                l.computeLineDistances();
                l.renderOrder = 6;
                this.overlay.add(l);
            }
        }
        for (const id of doc.multi) { const b = this._boxOf(id); if (b) add(b, 0xffd27a, 0.75); }
        const sel = doc.sel && this._boxOf(doc.sel);
        if (sel) add(sel, 0xffb347);
        const route = this.route();
        if (route?.length) {
            const o = byId(doc.sel), lift = p => new THREE.Vector3(p.x, this.groundY(p.x, p.z) + 0.3, p.z);
            const pts = [lift(o), ...route.map(lift), ...(route.length > 1 ? [lift(route[0])] : [])];
            const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xffb347, dashSize: 0.6, gapSize: 0.35, depthTest: false, transparent: true }));
            line.computeLineDistances();
            line.renderOrder = 7;
            this.overlay.add(line);
            route.forEach((p, i) => {
                const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: i === 0 ? 0xfff0c0 : 0xffb347, depthTest: false, transparent: true }));
                dot.position.copy(lift(p));
                dot.scale.setScalar(this._metresPerPx(dot.position) * 8);
                dot.renderOrder = 11;
                this.overlay.add(dot);
            });
        }
        this._placeHandle();
    }

    _placeHandle() {
        const o = doc.sel && byId(doc.sel);
        const b = o && this._boxOf(o.id);
        if (!o || !b || doc.multi.length) { this.handle.visible = false; return; }
        // Clear of the object, and at least 50 px out on screen, so a finger on a
        // small rock grabs the rock, not the handle.
        const r = Math.max(Math.hypot(b.max.x - b.min.x, b.max.z - b.min.z) / 2 + 0.6, 50 * this._metresPerPx(new THREE.Vector3(o.x, o.y || 0, o.z)));
        const a = o.rotY || 0;
        const y = this.groundY(o.x + Math.sin(a) * r, o.z + Math.cos(a) * r) + (o.y || 0) + 0.25;
        this.handle.visible = true;
        this.handle.position.set(o.x + Math.sin(a) * r, y, o.z + Math.cos(a) * r);
        this.handle.rotation.y = a;
        // Constant size on screen: ~11 px knob.
        const s = this._metresPerPx(this.handle.position) * 11;
        this.handle.knob.scale.setScalar(s);
        this.handle.stem.scale.set(s, r, s);
        this.handle.stem.position.set(0, 0, -r / 2);
        this.handleR = r;
    }

    _metresPerPx(p) {
        if (this.mode === 'plan') return 1 / this.plan.ppm;
        const d = this.persp.position.distanceTo(p);
        return 2 * d * Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)) / this.h;
    }

    _render() {
        this._placeHandle();
        this.grid && (this.grid.visible = this.show.grid);
        this.renderer.render(this.scene, this.camera);
    }

    // ---- picking -------------------------------------------------------------------------------------

    _ray(x, y) {
        const r = this.canvas.getBoundingClientRect();
        const v = new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
        const ray = new THREE.Raycaster();
        ray.setFromCamera(v, this.camera);
        return ray;
    }

    /** What's under the finger. Water (a lake, the sea) only when nothing else is: `{ water: true }` then. */
    pick(x, y, { detail = false } = {}) {
        const hits = this._ray(x, y).intersectObjects(this.world.children, true);
        let water = null;
        for (const hh of hits) {
            let o = hh.object;
            while (o && !o.userData.sceneId) o = o.parent;
            if (!o?.userData.sceneId || o.visible === false) continue;
            const id = o.userData.sceneId;
            if (CATALOG[byId(id)?.type]?.absolute) { water ||= id; continue; }
            return detail ? { id, water: false } : id;
        }
        return water ? (detail ? { id: water, water: true } : water) : null;
    }

    /** Where the finger meets the horizontal plane at height `y`. */
    groundAt(x, y, h = 0) {
        const p = new THREE.Vector3(), ray = this._ray(x, y).ray;
        if (this.terrain) return this.terrain.raycast(ray, 900) || (ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), p) ? p : null);
        return ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -h), p) ? p : null;
    }

    _screen(p) {
        const q = p.clone().project(this.camera);
        const r = this.canvas.getBoundingClientRect();
        return { x: r.left + (q.x + 1) / 2 * r.width, y: r.top + (1 - q.y) / 2 * r.height };
    }

    // ---- gestures -------------------------------------------------------------------------------------

    _gestures() {
        const el = this.canvas;
        const pts = new Map();
        let g = null;         // the gesture in progress
        const snapV = v => (this.snap ? Math.round(v / SNAP) * SNAP : Math.round(v * 100) / 100);

        el.addEventListener('contextmenu', e => e.preventDefault());
        el.addEventListener('pointerdown', e => {
            try { el.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic pointer: nothing to capture */ }
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pts.size === 2) { if (g?.kind === 'brush') this._endStroke(); this.boxEl.style.display = 'none'; g = this._pinchStart(pts); return; }
            if (pts.size > 2) return;
            const x = e.clientX, y = e.clientY;
            const pan = e.button === 2 || e.button === 1 || e.shiftKey;
            const o = doc.sel && byId(doc.sel);
            // The land brush takes one finger.
            if (!pan && this.brush && this.terrain) {
                const hit = this.groundAt(x, y);
                if (hit) {
                    checkpoint();
                    g = { kind: 'brush', level: this.terrain.height(hit.x, hit.z), last: hit, moved: true };
                    this._ringAt(hit);
                    this._dab(hit.x, hit.z, g);
                    return;
                }
            }
            // A route point of the selected character.
            const route = !pan && this.route();
            if (route) {
                for (let i = 0; i < route.length; i++) {
                    const s = this._screen(new THREE.Vector3(route[i].x, this.groundY(route[i].x, route[i].z) + 0.3, route[i].z));
                    if (Math.hypot(s.x - x, s.y - y) < ROUTE_PX) { g = { kind: 'routept', id: o.id, i, sx: x, sy: y, moved: false }; return; }
                }
            }
            if (!pan && o && this.handle.visible) {
                const s = this._screen(this.handle.position);
                if (Math.hypot(s.x - x, s.y - y) < 24) { g = { kind: 'turn', id: o.id, sx: x, sy: y, moved: false }; return; }
            }
            const hit0 = pan ? null : this.pick(x, y, { detail: true });
            // Water spreads under everything: a press on it pans (or draws a box) unless it's the one selected; a tap selects it.
            const tapWater = hit0?.water && doc.sel !== hit0.id ? hit0.id : null;
            const id = tapWater ? null : hit0?.id || null;
            if (hit0 && this.onPick?.(hit0.id)) { g = { kind: 'none' }; return; }     // a "pick an object" prompt took it
            if (id) {
                const was = isSelected(id);
                if (this.multi && !was) toggleSelect(id);
                else if (!this.multi && !(was && doc.multi.length)) select(id);
                const ob = byId(id);
                const hit = this.groundAt(x, y, ob.y || 0);
                // Every selected thing moves with the one under the finger.
                const group = selection().map(byId).filter(Boolean).map(q => ({ q, x: q.x, z: q.z }));
                g = { kind: 'move', id, sx: x, sy: y, moved: false, toggle: this.multi && was, hit0: hit, off: hit ? { x: ob.x - hit.x, z: ob.z - hit.z } : { x: 0, z: 0 }, group };
                return;
            }
            if (this.multi && !pan) { g = { kind: 'box', sx: x, sy: y, moved: false, tapWater }; return; }
            g = { kind: pan ? 'pan' : (this.mode === 'plan' ? 'pan' : 'orbit'), sx: x, sy: y, lx: x, ly: y, moved: false, tapWater, cam: { ...this.plan }, orb: { ...this.orbit } };
        });

        el.addEventListener('pointermove', e => {
            if (!pts.has(e.pointerId)) { if (this.brush && e.pointerType === 'mouse') this._ringAt(this.groundAt(e.clientX, e.clientY)); return; }
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (!g) return;
            if (g.kind === 'pinch') { this._pinchMove(g, pts); return; }
            const x = e.clientX, y = e.clientY;
            if (g.kind === 'brush') {
                const hit = this.groundAt(x, y);
                if (!hit) return;
                this._ringAt(hit);
                // A dab every half-radius along the stroke, so fast and slow strokes build the same.
                const step = Math.max(0.5, this.brush.size * 0.18);
                const d = Math.hypot(hit.x - g.last.x, hit.z - g.last.z);
                for (let t = step; t <= d; t += step) this._dab(g.last.x + (hit.x - g.last.x) * t / d, g.last.z + (hit.z - g.last.z) * t / d, g);
                if (d >= step) g.last = hit;
                return;
            }
            if (!g.moved && Math.hypot(x - g.sx, y - g.sy) < TAP_PX) return;
            if (!g.moved && (g.kind === 'move' || g.kind === 'turn' || g.kind === 'routept')) checkpoint();
            g.moved = true;
            if (g.kind === 'box') { this._boxSelect(g, x, y, false); return; }
            if (g.kind === 'routept') {
                const ob = byId(g.id), hit = this.groundAt(x, y);
                if (!hit) return;
                const r = parseRoute(ob.route);
                r[g.i] = { x: snapV(hit.x), z: snapV(hit.z) };
                ob.route = r.map(p => `${+p.x.toFixed(2)},${+p.z.toFixed(2)}`).join('; ');
                this._overlay();
                this.redraw();
                return;
            }
            if (g.kind === 'move') {
                const ob = byId(g.id);
                const hit = this.groundAt(x, y, ob.y || 0);
                if (!hit) return;
                const nx = snapV(hit.x + g.off.x), nz = snapV(hit.z + g.off.z), dx = nx - g.group.find(m => m.q === ob).x, dz = nz - g.group.find(m => m.q === ob).z;
                for (const m of g.group) { m.q.x = Math.round((m.x + dx) * 100) / 100; m.q.z = Math.round((m.z + dz) * 100) / 100; this._syncOne(m.q); }
                this._overlay();
                this.redraw();
                this.onLive?.(ob);
            } else if (g.kind === 'turn') {
                const ob = byId(g.id);
                const hit = this.groundAt(x, y, ob.y || 0);
                if (!hit) return;
                let a = Math.atan2(hit.x - ob.x, hit.z - ob.z);
                if (this.snap) a = Math.round(a / SNAP_ANGLE) * SNAP_ANGLE;
                ob.rotY = Math.round(a * 1e4) / 1e4;
                this._syncOne(ob);
                this._overlay();
                this.redraw();
                this.onLive?.(ob);
            } else if (g.kind === 'pan') {
                const dx = x - g.lx, dy = y - g.ly;
                g.lx = x; g.ly = y;
                this._panBy(dx, dy);
            } else if (g.kind === 'orbit') {
                const dx = x - g.lx, dy = y - g.ly;
                g.lx = x; g.ly = y;
                this.orbit.yaw -= dx * 0.006;
                this.orbit.pitch += dy * 0.005;
                this._cams();
                this.redraw();
            }
        });

        const end = e => {
            if (!pts.has(e.pointerId)) return;
            pts.delete(e.pointerId);
            if (!g) return;
            if (g.kind === 'pinch') { if (pts.size === 0) g = null; return; }
            if (g.kind === 'brush') { this._endStroke(); if (e.pointerType !== 'mouse') this._ringAt(null); g = null; return; }
            if (g.kind === 'box') { if (g.moved) this._boxSelect(g, e.clientX, e.clientY, true); else if (e.type === 'pointerup') (g.tapWater ? toggleSelect(g.tapWater) : select(null)); g = null; return; }
            if (g.kind === 'routept' && g.moved) changed('object:' + g.id);
            if (g.kind === 'move' && g.moved) changed(g.group.length > 1 ? 'objects' : 'object:' + g.id);
            if (g.kind === 'move' && !g.moved && g.toggle) toggleSelect(g.id);      // Select several: a tap on a selected one takes it out
            if (g.kind === 'turn' && g.moved) changed('object:' + g.id);
            if ((g.kind === 'pan' || g.kind === 'orbit') && !g.moved && e.type === 'pointerup') select(g.tapWater || null);
            g = null;
        };
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);

        el.addEventListener('wheel', e => {
            e.preventDefault();
            const f = Math.exp(-e.deltaY * 0.0015);
            this._zoomAt(e.clientX, e.clientY, f);
        }, { passive: false });
    }

    _pinchStart(pts) {
        const [a, b] = [...pts.values()];
        return { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }

    _pinchMove(g, pts) {
        if (pts.size < 2) return;
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        this._panBy(mx - g.mx, my - g.my);
        this._zoomAt(mx, my, d / Math.max(1, g.d));
        Object.assign(g, { d, mx, my });
    }

    _panBy(dx, dy) {
        if (this.mode === 'plan') {
            this.plan.cx -= dx / this.plan.ppm;
            this.plan.cz -= dy / this.plan.ppm;
        } else {
            const o = this.orbit, k = this._metresPerPx(new THREE.Vector3(o.tx, o.ty, o.tz));
            // Screen right on the ground is (cos, -sin); a drag down pulls the far side closer: the target moves away.
            o.tx -= (dx * Math.cos(o.yaw) + dy * Math.sin(o.yaw)) * k;
            o.tz -= (-dx * Math.sin(o.yaw) + dy * Math.cos(o.yaw)) * k;
        }
        this._cams();
        this.redraw();
    }

    _zoomAt(x, y, f) {
        if (this.mode === 'plan') {
            const before = this.groundAt(x, y);
            this.plan.ppm = Math.max(2, Math.min(160, this.plan.ppm * f));
            this._cams();
            const after = this.groundAt(x, y);
            if (before && after) { this.plan.cx += before.x - after.x; this.plan.cz += before.z - after.z; }
        } else {
            this.orbit.dist /= f;
        }
        this._cams();
        this.redraw();
    }

    // ---- thumbnails for the library -----------------------------------------------------------------------

    /** A small picture of each type, drawn once with a spare renderer. */
    static thumbnails(types, size = 112) {
        const canvas = document.createElement('canvas');
        const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
        r.setPixelRatio(1);
        r.setSize(size, size, false);
        r.toneMapping = THREE.ACESFilmicToneMapping;
        const scene = new THREE.Scene();
        scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x5a4a38, 0.9 * Math.PI));
        const sun = new THREE.DirectionalLight(0xffe2b8, 1.7 * Math.PI);
        sun.position.set(3, 6, 4);
        scene.add(sun);
        const cam = new THREE.PerspectiveCamera(32, 1, 0.05, 400);
        const out = {};
        for (const [key, item] of Object.entries(types)) {
            let m;
            try { m = modelOf({ id: 'thumb', x: 0, y: 0, z: 0, rotY: 0, ...item }); } catch (e) { continue; }
            scene.add(m);
            const b = new THREE.Box3().setFromObject(m);
            const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3()).length() || 1;
            const d = s / (2 * Math.tan(THREE.MathUtils.degToRad(16))) * 0.62;
            cam.position.set(c.x + d * 0.62, c.y + d * 0.5, c.z + d * 0.62);
            cam.lookAt(c);
            r.render(scene, cam);
            out[key] = canvas.toDataURL('image/png');
            scene.remove(m);
            m.traverse(o => o.geometry?.dispose());
        }
        r.dispose();
        r.forceContextLoss();
        return out;
    }
}

export { withDefaults, expandPrefab };
