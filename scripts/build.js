#!/usr/bin/env node
// ============================================================
// BUILD — the editor as one self-contained page for claude.ai
// ============================================================
//
// Bundles src/editor.js with the game's own code (game/ is the Elemental
// repository as a git submodule, pinned to a commit), so the editor draws
// and plays scenes with exactly the models and systems that ship:
//
//   /*@@JS@@*/       the bundle (three.js, cannon-es, the game's scene,
//                    story and element code, the editor)
//   /*@@DATA@@*/     the game's scenes/*.json, and the game commit
//   /*@@GAMECSS@@*/  the game's HUD styles, scoped to the Play overlay
//
// usage: npm run build [-- out.html]      (default dist/elemental-editor.html)
// ============================================================
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import * as esbuild from 'esbuild';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.argv[2] || 'dist/elemental-editor.html');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

if (!fs.existsSync(path.join(ROOT, 'game/src/Game.js'))) {
    console.error('game/ is missing: git submodule update --init');
    process.exit(1);
}

// ---- the bundle ------------------------------------------------------------------------
const bundle = await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/editor.js')],
    bundle: true, format: 'iife', minify: true, target: 'es2022', write: false, legalComments: 'none',
    logLevel: 'warning',
});
const js = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');

// ---- the game's scenes and commit ------------------------------------------------------------
const scenes = {};
for (const f of fs.readdirSync(path.join(ROOT, 'game/scenes')).filter(f => f.endsWith('.json')).sort()) {
    const s = JSON.parse(read('game/scenes/' + f));
    scenes[s.id] = s;
}
let game = 'unknown';
try { game = execSync('git -C game rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch (e) { /* not a checkout */ }
const data = JSON.stringify({ scenes, build: { game, built: new Date().toISOString().slice(0, 10) } }).replace(/<\//g, '<\\/');

// ---- the game's HUD styles, scoped to #play-root ---------------------------------------------------
// The game's stylesheet is written for a page of its own; inside the editor it
// only styles the Play overlay. Page-level rules (html, body, the title
// screen, the font file) are dropped; #hud becomes #play-hud.
function scopeGameCss(css) {
    css = css.replace(/@font-face\s*{[^}]*}/g, '');
    const out = [];
    const scopeSel = sel => sel.split(',').map(x => x.trim()).filter(Boolean).map(x => {
        if (x === ':root') return '#play-root';
        if (/^(html|body|\*|#game|#title|#boot-error|#hud)\b/.test(x) && !x.startsWith('#hud ')) return null;
        return '#play-root ' + x.replace(/#hud\b/g, '#play-hud');
    }).filter(Boolean).join(', ');
    // A tiny parser: blocks, with @media and @keyframes kept whole.
    let i = 0;
    while (i < css.length) {
        const open = css.indexOf('{', i);
        if (open < 0) break;
        const head = css.slice(i, open).trim();
        if (head.startsWith('@keyframes')) {
            let depth = 1, j = open + 1;
            while (depth && j < css.length) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
            out.push(css.slice(i, j).trim());
            i = j;
        } else if (head.startsWith('@media')) {
            let depth = 1, j = open + 1;
            while (depth && j < css.length) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
            const inner = scopeGameCss(css.slice(open + 1, j - 1));
            if (inner.trim()) out.push(`${head} { ${inner} }`);
            i = j;
        } else {
            const close = css.indexOf('}', open);
            const sel = scopeSel(head.replace(/\/\*[\s\S]*?\*\//g, ''));
            if (sel) out.push(`${sel} ${css.slice(open, close + 1)}`);
            i = close + 1;
        }
    }
    return out.join('\n');
}
const gameCss = scopeGameCss(read('game/css/styles.css').replace(/\/\*[\s\S]*?\*\//g, ''));

// ---- the page ----------------------------------------------------------------------------------------
let html = read('editor.html');
const fill = (marker, text) => {
    if (!html.includes(marker)) throw new Error('editor.html has no ' + marker);
    html = html.split(marker).join(text);
};
fill('/*@@GAMECSS@@*/', gameCss);
fill('/*@@DATA@@*/{}', data);
fill('/*@@JS@@*/', js);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`${path.relative(ROOT, OUT)}: ${(html.length / 1024 / 1024).toFixed(2)} MB · ${Object.keys(scenes).length} scenes · game ${game}`);
