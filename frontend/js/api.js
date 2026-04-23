// @ts-check
/** Thin wrapper around the scoreboard HTTP API so the game doesn't touch fetch directly. */

/**
 * @typedef {Object} ScoreRow
 * @property {number} id
 * @property {string} name
 * @property {'win'|'crime'} ending
 * @property {number} kills
 * @property {number} time_ms
 * @property {number} health
 * @property {number} years
 * @property {number} created_at
 */

const BASE = (window.BAM_PREFIX || '') + '/api';

/** @returns {Promise<ScoreRow[]>} */
export async function fetchTopScores() {
    const res = await fetch(`${BASE}/scores/top?limit=50`);
    if (!res.ok) throw new Error(`top scores: HTTP ${res.status}`);
    const data = await res.json();
    return data.scores;
}

/**
 * @param {Omit<ScoreRow, 'id' | 'created_at'>} payload
 * @returns {Promise<ScoreRow>}
 */
export async function submitScore(payload) {
    const res = await fetch(`${BASE}/scores`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`submit score: HTTP ${res.status} ${text}`);
    }
    const data = await res.json();
    return data.score;
}

/** Prompt the user for a name using the DOM overlay. Resolves with null if skipped. */
export function askForName() {
    return new Promise((resolve) => {
        const overlay = /** @type {HTMLElement} */ (document.getElementById('submit-overlay'));
        const form = /** @type {HTMLFormElement} */ (document.getElementById('submit-form'));
        const input = /** @type {HTMLInputElement} */ (form.elements.namedItem('name'));
        const skip = /** @type {HTMLButtonElement} */ (document.getElementById('submit-skip'));

        overlay.classList.add('show');
        overlay.setAttribute('aria-hidden', 'false');
        // Pull last name from local storage for quick retries
        input.value = localStorage.getItem('bam.playerName') || '';
        setTimeout(() => input.focus(), 50);

        const cleanup = () => {
            overlay.classList.remove('show');
            overlay.setAttribute('aria-hidden', 'true');
            form.removeEventListener('submit', onSubmit);
            skip.removeEventListener('click', onSkip);
        };
        const onSubmit = (e) => {
            e.preventDefault();
            const name = input.value.trim();
            if (!name) return;
            localStorage.setItem('bam.playerName', name);
            cleanup();
            resolve(name);
        };
        const onSkip = () => { cleanup(); resolve(null); };

        form.addEventListener('submit', onSubmit);
        skip.addEventListener('click', onSkip);
    });
}
