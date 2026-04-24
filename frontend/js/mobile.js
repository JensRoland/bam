// @ts-check
/**
 * Mobile support: on-screen touch controls + fullscreen toggle.
 *
 * The kaplay build pinned in main.js binds `keydown` / `keyup` listeners
 * directly to the canvas element and reads `event.key` (lowercased) to decide
 * which handler to fire. So the cleanest way to feed simulated input from DOM
 * buttons is to dispatch synthetic `KeyboardEvent`s on the same canvas — no
 * changes to scenes.js are required.
 *
 * Each button uses `data-key` (primary) and optional `data-alt-key` to dispatch
 * two keys simultaneously. The alt keys let the Fire/Swap buttons double as
 * menu confirm (`space`/`enter`) so a player on a touchscreen can navigate
 * splash → game → death → scoreboard without a keyboard.
 */

const TOUCH_QUERY_BYPASS = 'notouch';

/**
 * Touch-capable devices include phones, tablets, and some convertible laptops.
 * We use `?notouch` as an override so desktop testing with dev-tools emulation
 * can be forced off if needed.
 */
export function isTouchDevice() {
    const params = new URLSearchParams(window.location.search);
    if (params.has(TOUCH_QUERY_BYPASS)) return false;
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
}

/**
 * Wire up the DOM touch-control buttons so pointerdown/up on each dispatches
 * synthetic KeyboardEvents on the kaplay canvas.
 * @param {HTMLCanvasElement} canvas
 */
export function initTouchControls(canvas) {
    if (!isTouchDevice()) return;

    document.body.classList.add('touch');

    const press = (key) => {
        canvas.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    };
    const release = (key) => {
        canvas.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    };

    const buttons = document.querySelectorAll('#touch-controls .tc-btn');
    buttons.forEach((el) => {
        const btn = /** @type {HTMLButtonElement} */ (el);
        const key = btn.dataset.key;
        const altKey = btn.dataset.altKey;
        if (!key) return;

        // Track active state per-button so multi-touch doesn't confuse release
        // (e.g. finger slides off, pointercancel from a system gesture).
        let active = false;
        const activate = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (active) return;
            active = true;
            btn.classList.add('pressed');
            press(key);
            if (altKey) press(altKey);
            // Capture so pointerup fires on this button even if the finger
            // drifts off its hit area while held.
            try { btn.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
        };
        const deactivate = (e) => {
            if (!active) return;
            active = false;
            btn.classList.remove('pressed');
            release(key);
            if (altKey) release(altKey);
            try { btn.releasePointerCapture(e.pointerId); } catch { /* noop */ }
        };

        btn.addEventListener('pointerdown', activate);
        btn.addEventListener('pointerup', deactivate);
        btn.addEventListener('pointercancel', deactivate);
        // Long-press context menu on mobile Safari would swallow the touch;
        // suppress it so Fire/Swap don't accidentally pop the share sheet.
        btn.addEventListener('contextmenu', (e) => e.preventDefault());
    });

    // If the user's finger lifts outside the button after capture was dropped
    // (or if the tab loses focus mid-press) release every active key so the
    // player doesn't keep running forever.
    const releaseAllActive = () => {
        document.querySelectorAll('#touch-controls .tc-btn.pressed').forEach((el) => {
            const btn = /** @type {HTMLButtonElement} */ (el);
            btn.classList.remove('pressed');
            if (btn.dataset.key) release(btn.dataset.key);
            if (btn.dataset.altKey) release(btn.dataset.altKey);
        });
    };
    window.addEventListener('blur', releaseAllActive);
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) releaseAllActive();
    });
}

/**
 * Wire up the fullscreen toggle. Only shown when the browser actually supports
 * the Fullscreen API — iPhone Safari famously does not, and we don't want to
 * surface a broken button.
 * @param {HTMLElement} stage
 */
export function initFullscreen(stage) {
    const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('tc-fullscreen'));
    if (!btn) return;

    const supported = !!(
        document.fullscreenEnabled
        // @ts-ignore vendor prefix
        || document.webkitFullscreenEnabled
    );
    if (!supported) return;

    document.body.classList.add('has-fullscreen');

    const isFullscreen = () => !!(
        document.fullscreenElement
        // @ts-ignore vendor prefix
        || document.webkitFullscreenElement
    );

    const enter = () => {
        const req = stage.requestFullscreen
            // @ts-ignore vendor prefix
            || stage.webkitRequestFullscreen;
        if (req) req.call(stage).catch((err) => console.warn('[bam] fullscreen request failed:', err));
    };
    const leave = () => {
        const exit = document.exitFullscreen
            // @ts-ignore vendor prefix
            || document.webkitExitFullscreen;
        if (exit) exit.call(document).catch(() => { /* noop */ });
    };

    btn.addEventListener('click', () => {
        if (isFullscreen()) leave();
        else enter();
    });

    const refresh = () => {
        btn.textContent = isFullscreen() ? '⤫' : '⛶';
        btn.setAttribute('aria-label', isFullscreen() ? 'Exit fullscreen' : 'Enter fullscreen');
    };
    document.addEventListener('fullscreenchange', refresh);
    document.addEventListener('webkitfullscreenchange', refresh);
    refresh();
}
