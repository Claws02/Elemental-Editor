// ============================================================
// UI — small DOM helpers the panels share
// ============================================================

/** h('div.cls#id', { attrs, on: { click } }, ...children) */
export function h(spec, attrs = {}, ...kids) {
    if (typeof attrs !== 'object' || attrs === null || attrs instanceof Node || Array.isArray(attrs)) { kids.unshift(attrs); attrs = {}; }
    const m = spec.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
    const el = document.createElement(m?.[1] || 'div');
    for (const part of (m?.[2] || '').match(/[.#][\w-]+/g) || []) {
        if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
    }
    for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k === 'text') el.textContent = v;
        else if (k in el && typeof v !== 'string') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat(Infinity)) {
        if (k === null || k === undefined || k === false) continue;
        el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
}

export const $ = id => document.getElementById(id);

let _toastT = 0;
export function toast(msg, kind = '') {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'on ' + kind;
    clearTimeout(_toastT);
    _toastT = setTimeout(() => { t.className = ''; }, 2600);
}

/** A modal sheet. `build(close)` returns its content. Resolves when closed. */
export function sheet(title, build, { wide = false } = {}) {
    return new Promise(resolve => {
        const close = v => { m.remove(); resolve(v); };
        const m = h('div.modal', { on: { pointerdown: e => { if (e.target === m) close(null); } } },
            h('div.sheet' + (wide ? '.wide' : ''), { role: 'dialog', 'aria-label': title },
                h('div.sheet-head', h('h2', title), h('button.btn.ghost', { type: 'button', 'aria-label': 'Close', on: { click: () => close(null) } }, '✕')),
                build(close)));
        document.body.append(m);
        m.querySelector('input,textarea,select,button:not(.ghost)')?.focus();
    });
}

/** A confirmation built into the page (the viewer never shows confirm()). */
export function ask(title, text, yes = 'Yes', no = 'Cancel', danger = false) {
    return sheet(title, close => h('div.stack',
        h('p', text),
        h('div.acts',
            h('button.btn', { type: 'button', on: { click: () => close(false) } }, no),
            h('button.btn' + (danger ? '.danger' : '.primary'), { type: 'button', on: { click: () => close(true) } }, yes))));
}

// ---- form fields ------------------------------------------------------------------

let _fid = 0;
const fid = () => 'f' + (++_fid);

export function field(label, control, hint) {
    const id = control.id || (control.id = fid());
    return h('div.field', h('label', { for: id }, label), control, hint ? h('small.hint', hint) : null);
}

export function numberInput(value, { min, max, step = 0.1, onChange, id } = {}) {
    const inp = h('input.num', { type: 'number', inputmode: 'decimal', step: String(step), id: id || fid() });
    if (min !== undefined) inp.min = String(min);
    if (max !== undefined) inp.max = String(max);
    inp.value = fmt(value, step);
    const commit = () => {
        let v = parseFloat(inp.value);
        if (!isFinite(v)) { inp.value = fmt(value, step); return; }
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        value = v;
        inp.value = fmt(v, step);
        onChange?.(v);
    };
    inp.addEventListener('change', commit);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
    const nudge = d => { inp.value = fmt((parseFloat(inp.value) || 0) + d * step, step); commit(); };
    return h('span.numwrap',
        h('button.nudge', { type: 'button', 'aria-label': 'Less', tabindex: '-1', on: { click: () => nudge(-1) } }, '−'),
        inp,
        h('button.nudge', { type: 'button', 'aria-label': 'More', tabindex: '-1', on: { click: () => nudge(1) } }, '+'));
}

export function fmt(v, step = 0.1) {
    const d = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
    return (Math.round(v / step) * step).toFixed(d);
}

export function textInput(value, { onChange, placeholder = '', id, live = false } = {}) {
    const inp = h('input.txt', { type: 'text', value: value ?? '', placeholder, id: id || fid(), autocomplete: 'off', spellcheck: 'false' });
    inp.addEventListener(live ? 'input' : 'change', () => onChange?.(inp.value));
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
    return inp;
}

export function linesInput(lines, { onChange, rows = 3, placeholder = 'One line per row', id } = {}) {
    const ta = h('textarea.lines', { rows: String(rows), placeholder, id: id || fid() });
    ta.value = (lines || []).join('\n');
    ta.addEventListener('change', () => onChange?.(ta.value.split('\n').map(s => s.trim()).filter(Boolean)));
    return ta;
}

export function select(value, options, { onChange, id, empty } = {}) {
    const s = h('select.sel', { id: id || fid() });
    if (empty !== undefined) s.append(h('option', { value: '' }, empty));
    for (const o of options) {
        const [v, label] = Array.isArray(o) ? o : [o, o];
        s.append(h('option', { value: v }, label));
    }
    s.value = value ?? '';
    s.addEventListener('change', () => onChange?.(s.value));
    return s;
}

export function toggle(value, { onChange, id, label = '' } = {}) {
    const b = h('button.toggle', { type: 'button', role: 'switch', id: id || fid(), 'aria-checked': String(!!value) }, h('i'), label ? h('span', label) : null);
    b.addEventListener('click', () => { value = !value; b.setAttribute('aria-checked', String(value)); onChange?.(value); });
    return b;
}

export function seg(value, options, { onChange } = {}) {
    const wrap = h('div.seg', { role: 'group' });
    for (const o of options) {
        const [v, label] = Array.isArray(o) ? o : [o, o];
        const b = h('button', { type: 'button', 'aria-pressed': String(v === value) }, label);
        b.addEventListener('click', () => {
            wrap.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', 'false'));
            b.setAttribute('aria-pressed', 'true');
            onChange?.(v);
        });
        wrap.append(b);
    }
    return wrap;
}
