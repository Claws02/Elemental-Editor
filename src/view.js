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
// ============================================================

import { THREE } from '../game/src/engine/lib.js';
import { modelOf, withDefaults, expandPrefab } from '../game/src/scene/Catalog.js';
import { flagstoneFloor } from '../game/src/art/PropModels.js';
import { groundBase } from '../game/src/art/TownModels.js';
import { doc, changed, checkpoint, select, byId } from './doc.js';

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
        if (box.isEmpty()) { const g = doc.scene.settings?.ground?.half || 20; box.set(new THREE.Vector3(-g, 0, -g), new THREE.Vector3(g, 2, g)); }
        const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
        const span = Math.max(s.x, s.z, 4) * 1.15;
        this.plan.cx = c.x; this.plan.cz = c.z;
        this.plan.ppm = Math.max(2, Math.min(120, Math.min(this.w, this.h) / span));
        Object.assign(this.orbit, { tx: c.x, ty: 0, tz: c.z, dist: Math.max(8, span * 1.1) });
        this._cams();
        this.redraw();
    }

    // ---- the scene -------------------------------------------------------------------------

    /** Bring the drawn scene in line with doc.scene. */
    sync(what = 'all') {
        const scene = doc.scene;
        if (!scene) return;
        if (what === 'selection' || what === 'problems' || what === 'overlay') { this._overlay(); this.redraw(); return; }
        const g = scene.settings?.ground || { half: 20, style: 'grass' };
        const gk = g.half + g.style;
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
        m.root.position.set(x || 0, y || 0, z || 0);
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
        const sel = doc.sel && this._boxOf(doc.sel);
        if (sel) add(sel, 0xffb347);
        this._placeHandle();
    }

    _placeHandle() {
        const o = doc.sel && byId(doc.sel);
        const b = o && this._boxOf(o.id);
        if (!o || !b) { this.handle.visible = false; return; }
        // Clear of the object, and at least 50 px out on screen, so a finger on a
        // small rock grabs the rock, not the handle.
        const r = Math.max(Math.hypot(b.max.x - b.min.x, b.max.z - b.min.z) / 2 + 0.6, 50 * this._metresPerPx(new THREE.Vector3(o.x, o.y || 0, o.z)));
        const a = o.rotY || 0;
        const y = (o.y || 0) + 0.25;
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

    pick(x, y) {
        const hits = this._ray(x, y).intersectObjects(this.world.children, true);
        for (const hh of hits) {
            let o = hh.object;
            while (o && !o.userData.sceneId) o = o.parent;
            if (o?.userData.sceneId && o.visible !== false) return o.userData.sceneId;
        }
        return null;
    }

    /** Where the finger meets the horizontal plane at height `y`. */
    groundAt(x, y, h = 0) {
        const p = new THREE.Vector3();
        return this._ray(x, y).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -h), p) ? p : null;
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
            if (pts.size === 2) { g = this._pinchStart(pts); return; }
            if (pts.size > 2) return;
            const x = e.clientX, y = e.clientY;
            const pan = e.button === 2 || e.button === 1 || e.shiftKey;
            const o = doc.sel && byId(doc.sel);
            if (!pan && o && this.handle.visible) {
                const s = this._screen(this.handle.position);
                if (Math.hypot(s.x - x, s.y - y) < 24) { g = { kind: 'turn', id: o.id, sx: x, sy: y, moved: false }; return; }
            }
            const id = pan ? null : this.pick(x, y);
            if (id && this.onPick?.(id)) { g = { kind: 'none' }; return; }     // a "pick an object" prompt took it
            if (id) {
                select(id);
                const ob = byId(id);
                const hit = this.groundAt(x, y, ob.y || 0);
                g = { kind: 'move', id, sx: x, sy: y, moved: false, off: hit ? { x: ob.x - hit.x, z: ob.z - hit.z } : { x: 0, z: 0 } };
                return;
            }
            g = { kind: pan ? 'pan' : (this.mode === 'plan' ? 'pan' : 'orbit'), sx: x, sy: y, lx: x, ly: y, moved: false, cam: { ...this.plan }, orb: { ...this.orbit } };
        });

        el.addEventListener('pointermove', e => {
            if (!pts.has(e.pointerId)) return;
            pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (!g) return;
            if (g.kind === 'pinch') { this._pinchMove(g, pts); return; }
            const x = e.clientX, y = e.clientY;
            if (!g.moved && Math.hypot(x - g.sx, y - g.sy) < TAP_PX) return;
            if (!g.moved && (g.kind === 'move' || g.kind === 'turn')) checkpoint();
            g.moved = true;
            if (g.kind === 'move') {
                const ob = byId(g.id);
                const hit = this.groundAt(x, y, ob.y || 0);
                if (!hit) return;
                ob.x = snapV(hit.x + g.off.x);
                ob.z = snapV(hit.z + g.off.z);
                this._syncOne(ob);
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
            if ((g.kind === 'move' || g.kind === 'turn') && g.moved) changed('object:' + g.id);
            if ((g.kind === 'pan' || g.kind === 'orbit') && !g.moved && e.type === 'pointerup') select(null);
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
