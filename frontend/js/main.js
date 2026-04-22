// @ts-check
/**
 * Entry point: boots KAPLAY and hands off to scenes.js to register every scene.
 *
 * We use KAPLAY (maintained Kaboom.js fork) loaded from a pinned CDN URL.
 * The 480×270 internal resolution is letterboxed inside the canvas, which the
 * browser then renders with nearest-neighbor to the stage element for a
 * chunky 8-bit look.
 */

import kaplay from 'https://unpkg.com/kaplay@3001.0.19/dist/kaplay.mjs';
import { registerScenes } from './scenes.js';

const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('game'));
const loading = document.getElementById('loading');

// Internal resolution 512x288 gives exactly 2x scale to the 1024x576 canvas,
// so each virtual pixel maps to a clean 2x2 block and text renders crisply.
const k = kaplay({
    canvas,
    width: 512,
    height: 288,
    letterbox: true,
    pixelDensity: 1,
    crisp: true,
    background: [14, 20, 35],
    // Prevent the engine from hijacking common browser shortcuts.
    burp: false,
    global: false,
    debug: false,
});

try {
    registerScenes(k);
    // `?debug` (e.g. open http://127.0.0.1:8000/?debug) skips splash and drops
    // straight into a debugging arena: infinite health, all weapons with 500
    // ammo each, random enemies streaming in from the right.
    const debugMode = new URLSearchParams(window.location.search).has('debug');
    k.go(debugMode ? 'debug' : 'splash');
    if (loading) loading.remove();
} catch (err) {
    console.error('[bam] boot failed:', err);
    if (loading) {
        loading.textContent = 'BOOT FAILED — check console';
        loading.style.color = '#f55';
    }
}
