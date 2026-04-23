// @ts-check
/**
 * Viral share module.
 *
 * Two jobs:
 *   1. Build the share URL + message. Messages are deliberately spoiler-free:
 *      no "prison", no "years", no "crime" — just "SCORE: N, hoo-rah" so the
 *      surprise lands when the friend actually plays.
 *   2. Wire up the DOM share overlay (X / Facebook / Reddit / copy / native).
 *
 * Share URL shape: ``/?s=438&n=JENS&t=crime&ref=share``
 * The backend serves that URL with personalized og:title / og:description
 * meta tags so social-preview unfurls show the sharer's score.
 */

const SITE_ORIGIN = window.location.origin;
const SITE_PREFIX = window.BAM_PREFIX || '';

/** Format ms → "m:ss" for win-ending time shares. */
function fmtMs(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')}`;
}

/**
 * @typedef {Object} ScoreLike
 * @property {string} name
 * @property {'win'|'crime'} ending
 * @property {number} [kills]
 * @property {number} [time_ms]
 * @property {number} [health]
 * @property {number} [years]
 */

/** @param {ScoreLike} score */
function scoreNumber(score) {
    if (score.ending === 'win') return fmtMs(score.time_ms || 0);
    return String(score.years || 0);
}

/** @param {ScoreLike} score */
export function buildShareURL(score) {
    const u = new URL(SITE_ORIGIN + SITE_PREFIX + '/');
    u.searchParams.set('s', scoreNumber(score));
    u.searchParams.set('n', score.name);
    u.searchParams.set('t', score.ending);
    u.searchParams.set('ref', 'share');
    return u.toString();
}

/** @param {ScoreLike} score */
export function buildShareText(score) {
    if (score.ending === 'win') {
        return `I ran BRAVE AMERICA MAN in ${fmtMs(score.time_ms || 0)}. `
             + `You soldier enough to beat it? 🇺🇸💪 #BAMgame`;
    }
    return `SCORE: ${score.years || 0} on B.A.M. 🔥 `
         + `Your move, champion. 🇺🇸 HOO-RAH! #BAMgame`;
}

/**
 * Parse ?s=…&n=…&t=… from the current URL.
 * Returns null if the visitor didn't arrive via a share link.
 */
export function readChallenge() {
    const u = new URL(window.location.href);
    const s = u.searchParams.get('s');
    const n = u.searchParams.get('n');
    if (!s || !n) return null;
    const t = u.searchParams.get('t') === 'win' ? 'win' : 'crime';
    return {
        score: s.slice(0, 10),
        name: n.slice(0, 16),
        ending: /** @type {'win'|'crime'} */ (t),
        ref: u.searchParams.get('ref'),
    };
}

/**
 * Open the share DOM overlay, populated with the given score.
 * Resolves when the user closes it.
 * @param {ScoreLike} score
 * @returns {Promise<void>}
 */
export function openShare(score) {
    return new Promise((resolve) => {
        const overlay = document.getElementById('share-overlay');
        if (!overlay) return resolve();

        const url = buildShareURL(score);
        const text = buildShareText(score);
        const preview = document.getElementById('share-preview-text');
        if (preview) preview.textContent = text;

        const linkField = /** @type {HTMLInputElement} */ (document.getElementById('share-link'));
        if (linkField) linkField.value = url;

        const tw = /** @type {HTMLAnchorElement} */ (document.getElementById('share-twitter'));
        if (tw) {
            tw.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
        }
        const fb = /** @type {HTMLAnchorElement} */ (document.getElementById('share-facebook'));
        if (fb) {
            fb.href = `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
        }
        const rd = /** @type {HTMLAnchorElement} */ (document.getElementById('share-reddit'));
        if (rd) {
            rd.href = `https://www.reddit.com/submit?url=${encodeURIComponent(url)}&title=${encodeURIComponent(text)}`;
        }

        const copy = /** @type {HTMLButtonElement} */ (document.getElementById('share-copy'));
        if (copy) {
            copy.textContent = 'COPY LINK';
            copy.onclick = async () => {
                try {
                    await navigator.clipboard.writeText(url);
                    copy.textContent = 'COPIED!';
                    setTimeout(() => { copy.textContent = 'COPY LINK'; }, 1800);
                } catch (_err) {
                    // Fallback: highlight the field for manual copy.
                    linkField?.select();
                }
            };
        }

        const close = () => {
            overlay.classList.remove('show');
            overlay.setAttribute('aria-hidden', 'true');
            document.removeEventListener('keydown', onKey);
            resolve();
        };
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        const closeBtn = document.getElementById('share-close');
        if (closeBtn) closeBtn.onclick = close;
        document.addEventListener('keydown', onKey);

        overlay.classList.add('show');
        overlay.setAttribute('aria-hidden', 'false');
    });
}
