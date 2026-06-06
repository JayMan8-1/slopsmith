// Demo analytics — real impl set by demo.js; no-op in normal builds
window.slopsmithDemoTrack = window.slopsmithDemoTrack ?? null;

// Sync the play/pause button's icon and accessible state in one place so
// screen readers, tooltips, and aria-pressed stay aligned with playback.
// Updates the existing <img> child's src in place rather than rewriting
// innerHTML, so any future children (fallback label, loading spinner, …)
// survive state changes.
function setPlayButtonState(isPlaying) {
    const btn = document.getElementById('btn-play');
    if (!btn) return;
    const label = isPlaying ? 'Pause' : 'Play';
    const icon = isPlaying ? 'pause' : 'play';
    let img = btn.querySelector('img.button-icon-svg');
    if (!img) {
        img = document.createElement('img');
        img.className = 'button-icon-svg';
        img.alt = '';
        img.setAttribute('aria-hidden', 'true');
        btn.appendChild(img);
    }
    img.src = `/static/svg/${icon}.svg`;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
    btn.title = label;
}

// ── Global keyboard shortcuts ─────────────────────────────────────────────
//
// `/` focuses the active screen's search input (Library / Favorites);
// `Esc` while focused blurs and clears it. Mirrors the GitHub / Gmail
// convention. The listener bails when the user is already typing in
// any text-accepting element so it can't intercept normal typing —
// including inputs inside the filters drawer, plugin settings, or
// modal dialogs.
function _isTextInput(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT') {
        // Some <input> types (button, checkbox, radio, range, ...) don't
        // accept text; only intercept the ones that do.
        const t = (el.type || 'text').toLowerCase();
        return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t);
    }
    if (tag === 'TEXTAREA') return true;
    if (tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
}

function _isShortcutHelpKey(e) {
    return e.key === '?' || (e.shiftKey && (e.code === 'Slash' || e.key === '/'));
}

function _isShortcutHelpSuppressedTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    if (tag === 'INPUT') {
        const t = (el.type || 'text').toLowerCase();
        return ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(t);
    }
    if (tag === 'TEXTAREA') return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('#lib-filter-drawer, [role="dialog"], #edit-modal, .slopsmith-modal')) return true;
    return false;
}

function _activeSearchInput() {
    // Pick the search field for whichever screen is currently active.
    // No match (e.g. on the player or settings screen) means `/` does
    // nothing — the shortcut only fires where a search box exists.
    const active = document.querySelector('.screen.active');
    if (!active) return null;
    if (active.id === 'home') return document.getElementById('lib-filter');
    if (active.id === 'favorites') return document.getElementById('fav-filter');
    return null;
}

// ── Library keyboard navigation ──────────────────────────────────────────
//
// Arrow keys move a single "selected" item among the visible cards
// (grid view) or song rows (tree view). Enter plays the selected
// song. The selected element gets:
//   - native keyboard focus via .focus() so :focus-visible draws the
//     accessible ring (announced by screen readers, follows scroll)
//   - a `.selected` class that persists when focus drifts elsewhere
//     so the user can glance back and still see their place.
//
// Grid columns are inferred from the live computed grid template at
// the moment of navigation, so up/down works correctly across all
// breakpoints (1 / 2 / 3 / 4 cols depending on viewport).

function _isElementVisible(el) {
    // Walk ancestors looking for display:none. Handles collapsed
    // `.album-body` / `.artist-body` subtrees (hidden via CSS class
    // rules). Using a DOM walk rather than `offsetParent` avoids the
    // false-negative for `position:fixed` elements whose offsetParent
    // is null even when they are perfectly visible.
    if (!el) return false;
    let node = el;
    while (node && node !== document.body) {
        if (getComputedStyle(node).display === 'none') return false;
        node = node.parentElement;
    }
    return true;
}

// `_libNavItems` is consulted on every arrow / Enter / Space / Home /
// End / activation press, including during autorepeat. Re-running
// `querySelectorAll` + visibility filtering on every keypress is the
// dominant cost on large libraries (hundreds of nodes × per-keypress
// layout reads), so the result is memoised against a generation
// counter that's bumped only when the underlying DOM actually
// changes shape: render functions and `_toggleHeader` bump
// `_libNavGeneration`. Cache misses fall through to a fresh query.
let _libNavGeneration = 0;
let _libNavItemsCache = { gen: -1, items: [], container: null, mode: null, scope: null };
function _bumpLibNavGeneration() { _libNavGeneration++; }

function _libNavItems() {
    const active = document.querySelector('.screen.active');
    if (!active) return { items: [], container: null, mode: null };
    let tree, grid;
    if (active.id === 'home') {
        tree = document.getElementById('lib-tree');
        grid = document.getElementById('lib-grid');
    } else if (active.id === 'favorites') {
        tree = document.getElementById('fav-tree');
        grid = document.getElementById('fav-grid');
    } else {
        return { items: [], container: null, mode: null };
    }
    const treeMode = tree && !tree.classList.contains('hidden');
    const scope = treeMode ? tree : grid;
    // Cache key includes the active container — switching grid↔tree or
    // home↔favorites must miss even if the generation hasn't ticked.
    if (
        _libNavItemsCache.gen === _libNavGeneration &&
        _libNavItemsCache.scope === scope &&
        scope && document.body.contains(scope)
    ) {
        return {
            items: _libNavItemsCache.items,
            container: _libNavItemsCache.container,
            mode: _libNavItemsCache.mode,
        };
    }
    let items, container, mode;
    if (treeMode) {
        // List mode — include artist headers, album headers, and song
        // rows so arrow nav still works when artists/albums are
        // collapsed (only the headers are visible then). Filter to
        // the currently-displayed nodes so collapsed children don't
        // count as targets the keyboard can land on.
        const all = Array.from(tree.querySelectorAll(
            '.artist-header, .album-header, .song-row[data-play], .song-row[data-library-song][tabindex="0"]'
        ));
        items = all.filter(_isElementVisible);
        container = tree;
        mode = 'list';
    } else {
        items = Array.from((grid || document).querySelectorAll('.song-card[data-play], .song-card[data-library-song][tabindex="0"]'));
        container = grid;
        mode = 'grid';
    }
    _libNavItemsCache = { gen: _libNavGeneration, items, container, mode, scope };
    return { items, container, mode };
}

function _gridColumns(container) {
    // Count columns by grouping the first row of children by their
    // top coordinate. Robust against any grid-template-columns syntax
    // (`repeat(...)`, `auto-fit`, named lines, etc.) where naively
    // splitting `getComputedStyle().gridTemplateColumns` on whitespace
    // would miscount because of spaces inside `repeat(...)` /
    // `minmax(...)`. Falls back to 1 when the container is empty
    // so callers' max(1, ...) clamps stay valid.
    if (!container) return 1;
    const children = Array.from(container.children).filter(
        c => c && c.offsetParent !== null
    );
    if (!children.length) return 1;
    const firstTop = children[0].getBoundingClientRect().top;
    let cols = 0;
    for (const c of children) {
        // Allow ~1px slop for sub-pixel rounding so two children that
        // would visually align still group together.
        if (Math.abs(c.getBoundingClientRect().top - firstTop) < 1.5) cols++;
        else break;
    }
    return Math.max(1, cols);
}

// Tracked separately from `document.activeElement` so the persistent
// `.selected` highlight survives focus drifting elsewhere (clicks
// outside the grid, drawer opening, etc). Also lets us avoid a global
// `querySelectorAll('.selected')` on every arrow press — large
// libraries make that a noticeable hot path.
let _lastLibSelected = null;

// Tracks which list screen launched the player so Esc-from-player
// returns the user to that screen instead of always defaulting to
// the Library (slopsmith#126). Reset on every `playSong` call so a
// song launched from a deep-link / plugin screen still gets a sane
// fallback ('home').
let _playerOriginScreen = 'home';
let _settingsOriginScreen = 'home';

// One-shot flag set in `showScreen` when the user enters Home or
// Favorites. Consumed by the very next library render so the
// restored selection scrolls into view exactly once on screen entry
// (player → home, hard reload). Routine re-renders driven by
// search / sort / filter changes leave the user's scroll position
// alone — the highlight still re-applies, but they aren't yanked.
const _libScrollOnNextRender = { home: false, favorites: false };

// localStorage keys for "remember the last selection across reloads
// and after returning from the player". One key per screen so the
// Library and Favorites trees don't fight over the same slot. Only
// song-row / song-card selections are persisted — header selections
// in the tree are ephemeral by design (re-derived from arrow nav).
const _LIB_SELECTED_KEY = 'slopsmith.libLastSelected';
const _FAV_SELECTED_KEY = 'slopsmith.favLastSelected';
function _selectedKeyForActiveScreen() {
    const active = document.querySelector('.screen.active');
    if (!active) return null;
    if (active.id === 'home') return _LIB_SELECTED_KEY;
    if (active.id === 'favorites') return _FAV_SELECTED_KEY;
    return null;
}
function _persistLibSelection(el) {
    if (!el || !el.dataset) return;
    // Both local entries (data-play) and remote entries (data-library-song,
    // no data-play yet) are persisted so the selection highlight survives a
    // library re-render after sync or provider switch.
    const isLocal = !!el.dataset.play;
    const isRemote = !isLocal && !!el.dataset.librarySong;
    if (!isLocal && !isRemote) return;
    const key = _selectedKeyForActiveScreen();
    if (!key) return;
    // Stored as JSON `{f, a, p, s}`:
    //   f — encoded filename (local entries); drives data-play restore.
    //   a — artist, for future cross-page restore.
    //   p — encoded provider id; prevents cross-provider collisions.
    //   s — encoded song id (remote entries); drives data-library-song restore.
    // Older bare-string and {f,a}/{f,a,p} formats are still tolerated in
    // `_loadPersistedLibSelection`.
    const artist = el.dataset.artist || '';
    const provider = el.dataset.libraryProvider || '';
    // For synced provider entries (data-play + data-library-song both present),
    // persist both f and s so _restoreLibSelection can match the card by either
    // attribute after a post-sync re-render.
    const payload = isLocal
        ? { f: el.dataset.play, a: artist, p: provider, s: el.dataset.librarySong || '' }
        : { f: '', a: artist, p: provider, s: el.dataset.librarySong };
    try {
        localStorage.setItem(key, JSON.stringify(payload));
    } catch { /* private mode / quota */ }
}

function _loadPersistedLibSelection(key) {
    let raw = null;
    try { raw = localStorage.getItem(key); } catch { return null; }
    if (!raw) return null;
    // Tolerate the older bare-string format (just the encoded
    // filename) — older builds wrote that and we'd rather upgrade
    // silently than orphan the user's saved selection.
    if (raw[0] !== '{') return { f: raw, a: '', p: '', s: '' };
    try {
        const o = JSON.parse(raw);
        return (o && typeof o === 'object') ? { f: o.f || '', a: o.a || '', p: o.p || '', s: o.s || '' } : null;
    } catch { return null; }
}


function _setLibSelection(el, { focus = true } = {}) {
    if (!el) return;
    // Only the previously-tracked element needs its `.selected` class
    // cleared. classList.remove on an element that no longer carries
    // the class is a no-op, so a stale `_lastLibSelected` from a
    // re-render is harmless. Avoids the global `querySelectorAll`
    // pass that the earlier implementation ran on every keypress.
    if (_lastLibSelected && _lastLibSelected !== el) {
        _lastLibSelected.classList.remove('selected');
    }
    el.classList.add('selected');
    _lastLibSelected = el;
    // Save song selections to localStorage so a reload (or returning
    // from the player) can restore the highlight. Headers don't get
    // persisted — they don't carry a stable id and the tree's auto-
    // open heuristic re-derives them on each render anyway.
    _persistLibSelection(el);
    if (focus) {
        // `preventScroll: true` skips the browser's native focus-scroll,
        // then we run a single `scrollIntoView` so we don't double-jank
        // when the element is partially in view. The browser's default
        // focus scroll uses `block: 'nearest'` too but isn't smoothable
        // and can interact poorly with sticky headers.
        el.focus({ preventScroll: true });
    }
    _scrollSelectionIntoView(el);
}

// Scroll the selected element to keep it inside a margin from the
// viewport edges. Plain `scrollIntoView({block:'nearest'})` only
// reacts when the element is fully off-screen, so during arrow nav
// the selection drifts to the edge and stays partially visible
// until it falls off — feels laggy. Centering when the row enters
// the buffer zone keeps it comfortably on-screen as the user holds
// the arrow keys.
const _SCROLL_EDGE_MARGIN = 96;
function _scrollSelectionIntoView(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    if (r.top < _SCROLL_EDGE_MARGIN || r.bottom > vh - _SCROLL_EDGE_MARGIN) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
}

function _restoreLibSelection(scopeEl, screen, { scroll = true } = {}) {
    // Re-apply the persistent `.selected` class to whichever song
    // matches the saved filename. For the tree we also walk up and
    // open every collapsed ancestor so the restored row is actually
    // visible — the user shouldn't have to hunt for their place
    // inside a collapsed artist node.
    if (!scopeEl) return null;
    const key = screen === 'favorites' ? _FAV_SELECTED_KEY : _LIB_SELECTED_KEY;
    const saved = _loadPersistedLibSelection(key);
    if (!saved || (!saved.f && !saved.s)) return null;
    // Match by dataset values — both stored and DOM values are in the
    // encoded form, so no decoding is needed. Avoid interpolating persisted
    // data into CSS selectors so malformed localStorage can't make
    // querySelector throw and break rendering.
    //
    // Local entries: match data-play (f) + data-library-provider (p) when p
    // is present to avoid cross-provider collisions on the same filename.
    // Remote entries: match data-library-song (s) + data-library-provider (p).
    // When f is present but no data-play card matches (e.g. the file has not
    // been downloaded on this load), fall back to the s (provider song-id) so
    // a previously-synced remote selection can still be restored.
    let el = null;
    if (saved.f) {
        const candidates = scopeEl.querySelectorAll('.song-card[data-play], .song-row[data-play]');
        el = Array.from(candidates).find((node) => {
            if (node.dataset.play !== saved.f) return false;
            if (saved.p && node.dataset.libraryProvider !== saved.p) return false;
            return true;
        });
    }
    if (!el && saved.s) {
        const candidates = scopeEl.querySelectorAll('.song-card[data-library-song], .song-row[data-library-song]');
        el = Array.from(candidates).find((node) => {
            if (node.dataset.librarySong !== saved.s) return false;
            if (saved.p && node.dataset.libraryProvider !== saved.p) return false;
            return true;
        });
    }
    if (!el) return null;
    // Open every collapsed ancestor in the tree so the restored row
    // is on-screen; harmless on the grid since cards have no such
    // ancestors. Sync `aria-expanded` on the matching header inside
    // each ancestor too — bypassing `_toggleHeader` here would leave
    // assistive tech reporting "collapsed" while the visual is open.
    let n = el.parentElement;
    while (n && n !== scopeEl) {
        if (n.classList.contains('artist-row') || n.classList.contains('album-group')) {
            n.classList.add('open');
            const header = Array.from(n.children).find(c => c.classList.contains('artist-header') || c.classList.contains('album-header'));
            if (header) header.setAttribute('aria-expanded', 'true');
        }
        n = n.parentElement;
    }
    if (_lastLibSelected && _lastLibSelected !== el) {
        _lastLibSelected.classList.remove('selected');
    }
    el.classList.add('selected');
    _lastLibSelected = el;
    // Center the restored element in the viewport so the user's eye
    // lands on it instead of having to scan up from the bottom edge.
    // `block: 'center'` is forgiving of items already on-screen — the
    // browser only scrolls when needed to bring the requested
    // alignment into view.
    // Skip when the caller opts out (e.g. during search/filter/sort
    // re-renders, where the user's scroll position should be left
    // alone and only the `.selected` class is re-applied).
    if (scroll) {
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
    }
    return el;
}

function _moveSelectionInItems(items, deltaIdx) {
    // Items are passed in by the caller so we don't re-query the DOM
    // twice per keypress (handler queries `_libNavItems`, then we'd
    // query it again).
    if (!items.length) return false;
    const current = document.activeElement && items.includes(document.activeElement)
        ? document.activeElement
        : (_lastLibSelected && items.includes(_lastLibSelected) ? _lastLibSelected : null);
    let idx = current ? items.indexOf(current) : -1;
    let next;
    if (idx === -1) {
        // No current selection — first arrow lands on the first item
        // regardless of direction. Saves a press.
        next = items[0];
    } else {
        next = items[Math.max(0, Math.min(items.length - 1, idx + deltaIdx))];
    }
    _setLibSelection(next);
    return true;
}

function _isInsideInteractiveControl(el) {
    // Bail when the user is interacting with anything that has its
    // own keyboard semantics — form controls (checkbox / select /
    // button) consume arrow keys for their own behavior, and the
    // filters drawer is a focus trap of those. Without this guard the
    // library's arrow nav would steal arrow presses from a focused
    // tuning checkbox or sort dropdown.
    if (!el) return false;
    const tag = el.tagName;
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag)) return true;
    if (el.isContentEditable) return true;
    if (el.closest && el.closest('#lib-filter-drawer, [role="dialog"], #edit-modal')) return true;
    return false;
}

function _handleLibArrowNav(e) {
    // Space (' ') is the standard activation key for focusable
    // elements alongside Enter — without it, a screen-reader user
    // hitting Space on a focused card would just scroll the page
    // instead of activating it. We treat Space identically to Enter
    // inside this handler.
    const isActivate = e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar';
    if (!isActivate &&
        !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
        return false;
    }
    if (_isInsideInteractiveControl(document.activeElement)) return false;
    const { items, container, mode } = _libNavItems();
    if (!items.length) return false;

    const currentTarget = (document.activeElement && items.includes(document.activeElement))
        ? document.activeElement
        : (_lastLibSelected && items.includes(_lastLibSelected) ? _lastLibSelected : null);

    if (isActivate) {
        if (!currentTarget) return false;
        e.preventDefault();
        // Sync persistent selection before activating so Tab-then-Enter
        // (no prior arrow nav or mouse click) still lights up the `.selected`
        // ring and updates `_lastLibSelected`/localStorage — consistent with
        // the click delegate at the bottom of this file.
        _setLibSelection(currentTarget, { focus: false });
        if (currentTarget.classList.contains('song-row') ||
            currentTarget.classList.contains('song-card')) {
            if (currentTarget.dataset.librarySong && !currentTarget.dataset.play) {
                const providerId = decodeURIComponent(currentTarget.dataset.libraryProvider || '');
                if (!_providerSupports(providerId, 'song.sync')) return true;
                syncLibrarySong(
                    providerId,
                    decodeURIComponent(currentTarget.dataset.librarySong || ''),
                    { playWhenReady: true },
                );
                return true;
            }
            // Song row OR card → play it. Pass `dataset.play` raw to
            // match the click delegate; `playSong` handles decoding
            // internally so decoding here would double-decode and
            // throw `URIError` on filenames containing `%`.
            playSong(currentTarget.dataset.play, undefined, { bridge: false });
        } else if (currentTarget.classList.contains('artist-header') ||
                   currentTarget.classList.contains('album-header')) {
            // Header row → toggle the parent open/closed and re-derive
            // visible items so the next arrow press lands correctly.
            // `_toggleHeader` keeps `aria-expanded` in sync for
            // assistive tech.
            _toggleHeader(currentTarget);
            // Keep keyboard focus on the header we just toggled —
            // browsers sometimes drop focus to body when the
            // surrounding subtree changes display.
            currentTarget.focus({ preventScroll: true });
        }
        return true;
    }

    if (e.key === 'Home') { e.preventDefault(); _setLibSelection(items[0]); return true; }
    if (e.key === 'End')  { e.preventDefault(); _setLibSelection(items[items.length - 1]); return true; }

    if (mode === 'list') {
        if (e.key === 'ArrowDown') { e.preventDefault(); _moveSelectionInItems(items, 1); return true; }
        if (e.key === 'ArrowUp')   { e.preventDefault(); _moveSelectionInItems(items, -1); return true; }
        // Right/Left expand and collapse the artist/album under focus,
        // file-manager style. With nothing selected yet, both keys
        // initialize selection on the first visible item (matches
        // Up/Down behavior in `_moveSelectionInItems`) so the first
        // press doesn't fall through to native scroll.
        if (!currentTarget && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
            e.preventDefault();
            _setLibSelection(items[0]);
            return true;
        }
        if (e.key === 'ArrowRight' && currentTarget) {
            const parent = (currentTarget.classList.contains('artist-header') ||
                            currentTarget.classList.contains('album-header'))
                ? currentTarget.parentElement : null;
            if (parent && !parent.classList.contains('open')) {
                e.preventDefault();
                // Use the shared toggle path so aria-expanded stays
                // synced with the visual state for screen readers.
                _toggleHeader(currentTarget);
                currentTarget.focus({ preventScroll: true });
                return true;
            }
            // Already open — step to the next visible item (which is
            // the first child of this header).
            e.preventDefault();
            _moveSelectionInItems(items, 1);
            return true;
        }
        if (e.key === 'ArrowLeft' && currentTarget) {
            // If on an open header, collapse it. If on a song row or
            // closed header, jump to the nearest enclosing header.
            const isHeader = currentTarget.classList.contains('artist-header') ||
                             currentTarget.classList.contains('album-header');
            const headerParent = isHeader ? currentTarget.parentElement : null;
            if (headerParent && headerParent.classList.contains('open')) {
                e.preventDefault();
                _toggleHeader(currentTarget);
                currentTarget.focus({ preventScroll: true });
                return true;
            }
            // Walk up to the nearest .album-header / .artist-header
            // ancestor's sibling header. Closest album-group → its
            // header; otherwise closest artist-row → its header.
            const albumGroup = currentTarget.closest('.album-group');
            if (albumGroup && albumGroup.contains(currentTarget) &&
                !currentTarget.classList.contains('album-header')) {
                e.preventDefault();
                _setLibSelection(albumGroup.querySelector('.album-header'));
                return true;
            }
            const artistRow = currentTarget.closest('.artist-row');
            if (artistRow && !currentTarget.classList.contains('artist-header')) {
                e.preventDefault();
                _setLibSelection(artistRow.querySelector('.artist-header'));
                return true;
            }
            return false;
        }
        return false;
    }
    // Grid mode: 2D nav. Columns are read from the live CSS grid so
    // we follow the responsive breakpoints automatically.
    const cols = _gridColumns(container);
    if (e.key === 'ArrowRight') { e.preventDefault(); _moveSelectionInItems(items, 1); return true; }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); _moveSelectionInItems(items, -1); return true; }
    if (e.key === 'ArrowDown')  { e.preventDefault(); _moveSelectionInItems(items, cols); return true; }
    if (e.key === 'ArrowUp')    { e.preventDefault(); _moveSelectionInItems(items, -cols); return true; }
    return false;
}

// Focus trap: keep Tab / Shift+Tab cycling inside `modal` so focus
// can't escape to the content underneath while the overlay is open.
// Call this once after the modal is in the DOM and initial focus is set.
function _trapFocusInModal(modal) {
    const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
    modal.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        const els = Array.from(modal.querySelectorAll(FOCUSABLE)).filter(el => {
            if (!_isElementVisible(el)) return false;
            if (getComputedStyle(el).visibility === 'hidden') return false;
            if (el.disabled) return false;
            return true;
        });
        if (!els.length) return;
        const first = els[0];
        const last = els[els.length - 1];
        if (e.shiftKey) {
            if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
            if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    });
}

// Styled async confirm dialog. Returns a Promise<boolean>. For destructive
// prompts pass `danger: true` — confirm button turns red and Cancel gets
// initial focus so an accidental Enter won't fire the action. `body` is
// inserted as HTML so callers can use formatting; callers are responsible
// for escaping any user-supplied content in it (use _escAttr).
function _confirmDialog({ title, body = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
    return new Promise((resolve) => {
        const previouslyFocused = document.activeElement;
        const modal = document.createElement('div');
        modal.className = 'slopsmith-modal fixed inset-0 z-[250] flex items-center justify-center bg-black/70 backdrop-blur-sm';
        modal.setAttribute('role', 'alertdialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-label', title || 'Confirm');
        const confirmClass = danger
            ? 'flex-1 bg-red-600 hover:bg-red-500 px-4 py-2 rounded-xl text-sm font-semibold text-white transition focus:outline-none focus:ring-2 focus:ring-red-400/60'
            : 'flex-1 bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-sm font-semibold text-white transition focus:outline-none focus:ring-2 focus:ring-accent/60';
        modal.innerHTML = `
            <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-sm mx-4 shadow-2xl">
                <h3 class="text-lg font-bold text-white mb-3">${_escAttr(title || '')}</h3>
                <div class="mb-5">${body}</div>
                <div class="flex gap-3">
                    <button type="button" data-confirm class="${confirmClass}">${_escAttr(confirmText)}</button>
                    <button type="button" data-cancel class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300 transition focus:outline-none focus:ring-2 focus:ring-gray-500/40">${_escAttr(cancelText)}</button>
                </div>
            </div>`;
        document.body.appendChild(modal);

        function finish(result) {
            modal.remove();
            document.removeEventListener('keydown', onKey, true);
            if (previouslyFocused && document.body.contains(previouslyFocused)) {
                try { previouslyFocused.focus({ preventScroll: true }); } catch {}
            }
            resolve(result);
        }
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false); }
            else if (e.key === 'Enter' && document.activeElement === modal.querySelector('[data-confirm]')) {
                e.preventDefault(); finish(true);
            }
        }
        modal.addEventListener('click', (e) => {
            if (e.target === modal) finish(false);
            else if (e.target.closest('[data-confirm]')) finish(true);
            else if (e.target.closest('[data-cancel]')) finish(false);
        });
        document.addEventListener('keydown', onKey, true);
        _trapFocusInModal(modal);
        // Focus Cancel by default for destructive prompts so an accidental
        // Enter / Space won't fire the dangerous action; otherwise focus
        // the confirm button so Enter accepts.
        const focusTarget = modal.querySelector(danger ? '[data-cancel]' : '[data-confirm]');
        if (focusTarget) focusTarget.focus({ preventScroll: true });
    });
}

// Shortcut cheat-sheet overlay. Opens on `?` (Shift+/), closes on
// Esc (handled by the generic modal close path) or on backdrop /
// close-button click. The list mirrors the canonical shortcut table
// in this file's keydown handler — when a shortcut changes here, the
// table below should change too. We keep it inline rather than
// fetching a separate file so the cheat sheet can never disagree
// with the version of app.js the user actually loaded.
function _openShortcutsModal() {
    if (document.getElementById('shortcuts-modal')) return;

    function _isTreeMode() {
        // Check if we're in tree view (not grid) on the active library screen
        const screen = document.querySelector('.screen.active');
        if (!screen) return false;
        const tree = screen.querySelector('#lib-tree,#fav-tree');
        return tree && !tree.classList.contains('hidden');
    }

    const ctx = _getCurrentContext();

    // Library shortcuts that are handled by the navigation system (not in registry)
    const navShortcuts = [
        { keys: '↑ ↓', desc: 'Move selection' },
        { keys: '→', desc: 'Step in', condition: _isTreeMode },
        { keys: '←', desc: 'Step out', condition: _isTreeMode },
        { keys: 'Home / End', desc: 'Jump to first / last item' },
        { keys: 'Enter / Space', desc: 'Activate selection (play song / toggle header)' },
    ];

    // Filter out items whose condition returns false
    const filterNavItems = (items) => items.filter(item => !item.condition || item.condition());

    // Format a shortcut entry for display, including modifier prefixes
    const formatShortcut = (s) => {
        const mods = s.modifiers || {};
        let label = '';
        if (mods.ctrl) label += 'Ctrl+';
        if (mods.alt) label += 'Alt+';
        if (mods.shift) label += 'Shift+';
        if (mods.meta) label += 'Meta+';
        return label + s.key;
    };

    // Get shortcuts from active panel by scope
    const getPanelShortcuts = (panel, scope) => {
        const shortcuts = [];
        for (const [key, s] of panel.shortcuts) {
            if (s.scope === scope) {
                shortcuts.push({ keys: formatShortcut(s), desc: s.description });
            }
        }
        return shortcuts;
    };

    const activePanel = _panels.get(_activePanel);
    const defaultPanel = _panels.get('default');

    // Merge shortcuts from both active and default panel for display
    const mergeShortcuts = (scope) => {
        const result = [];
        if (activePanel) result.push(...getPanelShortcuts(activePanel, scope));
        if (defaultPanel && defaultPanel !== activePanel) result.push(...getPanelShortcuts(defaultPanel, scope));
        return result;
    };

    const playerShortcuts = mergeShortcuts('player');
    const globalShortcuts = mergeShortcuts('global');
    const libraryShortcuts = mergeShortcuts('library');

    // Get plugin shortcuts for current plugin screen
    const pluginShortcuts = [];
    if (ctx.isPlugin && activePanel) {
        for (const [key, s] of activePanel.shortcuts) {
            if (s.scope.startsWith('plugin-') && s.scope === ctx.screen) {
                pluginShortcuts.push({ keys: formatShortcut(s), desc: s.description });
            }
        }
    }

    // Get shortcuts from other panels (if multiple panels exist)
    const otherPanelShortcuts = [];
    if (_panels.size > 1) {
        for (const [panelId, panel] of _panels) {
            if (panelId === _activePanel) continue;
            for (const [key, s] of panel.shortcuts) {
                otherPanelShortcuts.push({ keys: formatShortcut(s), desc: s.description, panel: panelId });
            }
        }
    }

    // Build sections based on current context
    const sections = [];
    if (ctx.isSettings) {
        sections.push({ heading: 'Settings', items: mergeShortcuts('settings') });
    } else if (ctx.isLibrary) {
        sections.push({ heading: 'Library', items: [
            ...filterNavItems(navShortcuts),
            ...libraryShortcuts,
            { keys: 'Esc', desc: 'Clear search' }
        ]});
    }
    if (ctx.isPlayer) {
        sections.push({ heading: 'Player', items: playerShortcuts });
    }
    if (!ctx.isSettings && globalShortcuts.length > 0) {
        sections.push({ heading: 'Global', items: globalShortcuts });
    }
    if (pluginShortcuts.length > 0) {
        sections.push({ heading: 'Current Plugin', items: pluginShortcuts });
    }
    if (otherPanelShortcuts.length > 0) {
        // Group other panel shortcuts by panel
        const byPanel = new Map();
        for (const item of otherPanelShortcuts) {
            if (!byPanel.has(item.panel)) {
                byPanel.set(item.panel, []);
            }
            byPanel.get(item.panel).push(item);
        }
        for (const [panelId, items] of byPanel) {
            sections.push({ heading: `Panel ${panelId}`, items });
        }
    }

    const modal = document.createElement('div');
    modal.id = 'shortcuts-modal';
    modal.className = 'slopsmith-modal fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Keyboard shortcuts');
    // Record the element that triggered the modal so Esc / close can
    // return focus to the correct entry even if _lastLibSelected drifts.
    // Scope to the active screen so a stale _lastLibSelected from a
    // different screen (e.g. Library vs Favorites) doesn't receive focus.
    const _scModal = document.querySelector('.screen.active');
    modal._opener = (_lastLibSelected && document.body.contains(_lastLibSelected)
        && _scModal && _scModal.contains(_lastLibSelected))
        ? _lastLibSelected : null;

    const sectionsHtml = sections.map(section => {
        const itemsHtml = section.items.map(({ keys, desc }) => `
            <div class="flex items-baseline justify-between gap-4 py-1.5">
                <span class="text-sm text-gray-300">${esc(desc)}</span>
                <kbd class="text-xs font-mono px-2 py-0.5 rounded bg-dark-600 border border-gray-700 text-gray-200 whitespace-nowrap">${esc(keys)}</kbd>
            </div>
        `).join('');
        return `
            <section class="mb-4 last:mb-0">
                <h4 class="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-2">${esc(section.heading)}</h4>
                ${itemsHtml}
            </section>
        `;
    }).join('');

    modal.innerHTML = `
        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
            <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-bold text-white">Keyboard shortcuts</h3>
                <button type="button" data-shortcuts-close
                        class="text-gray-500 hover:text-white transition flex items-center gap-1.5" aria-label="Close shortcuts">
                    <span class="text-xs text-gray-600">Esc</span>
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
            </div>
            ${sectionsHtml}
        </div>
    `;

    // Click outside the inner panel (i.e. on the backdrop) closes the
    // modal — matches the conventional dialog UX.
    modal.addEventListener('click', (ev) => {
        if (ev.target === modal || ev.target.closest('[data-shortcuts-close]')) {
            const opener = modal._opener;
            modal.remove();
            const focusTarget = (opener && document.body.contains(opener)) ? opener
                : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
            if (focusTarget) focusTarget.focus({ preventScroll: true });
        }
    });

    document.body.appendChild(modal);
    // Move focus into the dialog so background shortcuts (and arrow
    // nav) can't fire on the underlying library entry while the
    // overlay is open. Close button is the safe default — there's no
    // primary input to focus on a read-only cheat sheet.
    const closeBtn = modal.querySelector('[data-shortcuts-close]');
    if (closeBtn) closeBtn.focus({ preventScroll: true });
    // Trap Tab / Shift+Tab inside the modal so focus can't escape to
    // the library content underneath while the overlay is open.
    _trapFocusInModal(modal);
}

document.addEventListener('keydown', (e) => {
    // Modifier-key combos belong to the browser / OS shortcuts; never
    // intercept those.
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (_handleLibArrowNav(e)) return;

    // `?` (Shift+/) opens the keyboard-shortcuts cheat sheet. Some
    // Linux/Electron stacks report Shift+/ as key='/' with code='Slash',
    // so check the help shape before treating plain '/' as search.
    if (_isShortcutHelpKey(e)) {
        if (_isShortcutHelpSuppressedTarget(e.target || document.activeElement)) return;
        e.preventDefault();
        // Stop other keydown listeners on document (notably the shortcut
        // registry below) from also consuming this event — otherwise a
        // Linux/Electron Shift+Slash reported as key='/' opens help here and
        // then the registry's plain `/` library-search shortcut focuses
        // #lib-filter behind the modal. (Copilot review on #602.)
        e.stopImmediatePropagation();
        _openShortcutsModal();
        return;
    }

    if (e.key === '/') {
        if (_isTextInput(document.activeElement)) return;
        // Also bail when focus is inside the filter drawer, a dialog, or
        // any other interactive region — those contexts have their own
        // keyboard semantics and shouldn't be hijacked by the search
        // shortcut (e.g. a focused checkbox inside the filters drawer).
        if (_isInsideInteractiveControl(document.activeElement)) return;
        const search = _activeSearchInput();
        if (!search) return;
        e.preventDefault();  // suppress the literal '/' the input would receive
        search.focus();
        // Move caret to end without mutating .value — round-tripping
        // the value resets the browser's undo stack and can fire
        // unexpected input events on some engines. setSelectionRange
        // is the no-side-effects path.
        try {
            const len = search.value.length;
            search.setSelectionRange(len, len);
        } catch {
            // Some input types (search/email/tel) don't support
            // selection APIs in older browsers; the focus alone is
            // still useful, just no caret-end guarantee.
        }
        return;
    }

    // Single-letter shortcuts that act on the focused / selected
    // library entry — works on both grid cards and tree rows. Each
    // dispatches to a button class that the entry markup already
    // exposes, so plugins can keep owning the actual behavior:
    //   c → .sloppak-convert-btn  (Sloppak Converter plugin)
    //   f → .fav-btn              (favorite heart toggle)
    //   e → .edit-btn             (edit metadata modal)
    // No-op when no entry is currently focused / selected, when the
    // entry doesn't expose the requested button (e.g. a sloppak
    // entry has no convert button), or when the button is disabled.
    // Bails on text input / drawer focus so single-letter typing in
    // inputs still works.
    const entryShortcut = { c: 'button.sloppak-convert-btn', f: 'button.fav-btn', e: 'button.edit-btn' }[e.key.toLowerCase()];
    if (entryShortcut) {
        if (_isInsideInteractiveControl(document.activeElement)) return;
        const ae = document.activeElement;
        const activeScreen = document.querySelector('.screen.active');
        const isEntry = el => el && el.classList && (el.classList.contains('song-card') || el.classList.contains('song-row'));
        // Scope both candidates to the active screen so that a stale
        // _lastLibSelected from Library doesn't fire when the user is
        // on Favorites (or vice-versa), and so pressing f/e/c on a
        // hidden screen can't accidentally persist that filename into
        // the current screen's localStorage key.
        const inActiveScreen = el => activeScreen && activeScreen.contains(el);
        const target = (isEntry(ae) && inActiveScreen(ae)) ? ae
            : (isEntry(_lastLibSelected) && inActiveScreen(_lastLibSelected) ? _lastLibSelected : null);
        if (!target) return;
        const btn = target.querySelector(entryShortcut);
        if (!btn || btn.disabled) return;
        e.preventDefault();
        // Sync the persistent selection to the acted-on entry so that
        // Esc-to-close-modal returns focus to the correct element and
        // the `.selected` highlight stays consistent with the action.
        _setLibSelection(target, { focus: false });
        btn.click();
        return;
    }

    if (e.key === 'Escape') {
        // Modal-first: close the topmost open modal (edit-metadata,
        // shortcuts cheat sheet, future modals) so Esc dismisses
        // from anywhere — including when keyboard focus is inside
        // a form field within the modal. Restores focus to the
        // element that opened the modal (tracked in modal._opener)
        // so arrow nav resumes without an extra Tab; falls back to
        // _lastLibSelected when the opener is no longer in the DOM.
        const modals = document.querySelectorAll('[role="dialog"][aria-modal="true"].slopsmith-modal');
        if (modals.length) {
            e.preventDefault();
            e.stopImmediatePropagation();
            const modal = modals[modals.length - 1];
            const opener = modal._opener;
            modal.remove();
            const focusTarget = (opener && document.body.contains(opener)) ? opener
                : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
            if (focusTarget) focusTarget.focus({ preventScroll: true });
            return;
        }
        // Esc while typing in either search box clears + blurs. Other Esc
        // semantics (drawer close, screen back) are handled elsewhere; we
        // only act when a search box is the focused element.
        const ae = document.activeElement;
        if (ae && (ae.id === 'lib-filter' || ae.id === 'fav-filter')) {
            if (ae.value) {
                ae.value = '';
                ae.dispatchEvent(new Event('input', { bubbles: true }));
            }
            ae.blur();
        }
    }
});

// ── Screen Navigation ─────────────────────────────────────────────────────
async function showScreen(id) {
    // Capture the previous screen before changing active classes
    const prevScreenId = document.querySelector('.screen.active')?.id;
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    // Mark the next render as a screen-entry so it scrolls the
    // restored selection into view exactly once. Routine renders
    // (search / sort / filter typing) won't have this flag set and
    // so won't yank the viewport. Also bump the nav-items
    // generation so the next keypress doesn't reuse a cache built
    // against a now-hidden screen's container.
    _bumpLibNavGeneration();
    if (id === 'home') {
        _libScrollOnNextRender.home = true;
        const beforeProviderId = _activeLibraryProviderId();
        await loadLibraryProviders({ restoreSaved: true });
        if (_activeLibraryProviderId() !== beforeProviderId) {
            _resetLibraryProviderViewState();
        } else {
            _libEpoch++;
            currentPage = 0;
            _treeStats = null;
            stopInfiniteScroll();
        }
        loadLibrary(0);
    }
    if (id === 'favorites') { _libScrollOnNextRender.favorites = true; loadFavorites(); }
    if (id === 'settings') {
        // Record where we came from so Esc can go back. The player screen
        // is torn down by the `id !== 'player'` branch below, so
        // re-entering it via showScreen() would land on a dead screen —
        // fall back to the player's own origin (or 'home') instead.
        if (prevScreenId && prevScreenId !== 'settings') {
            _settingsOriginScreen = prevScreenId === 'player'
                ? (_playerOriginScreen || 'home')
                : prevScreenId;
        }
        loadSettings();
    }
    if (id === 'player') {
        _ensureSpeedSliderWired();
    }
    if (id !== 'player') {
        const audio = document.getElementById('audio');
        const stopTime = _audioTime();
        const hadPlayableSong = !!audio.src || !!window._juceAudioUrl || isPlaying;
        highway.stop();
        // Cancel any queued seeks, in-flight shim closures, AND active
        // count-in timers before stopping playback so none of these paths
        // can mutate the torn-down session (mirrors the same triple reset
        // in playSong()).
        _cancelCountIn();
        _resetJuceAudioShimChain();
        _resetAudioSeekState();
        if (window._juceMode) {
            // HTML5 emits 'pause' via the media-element listener below;
            // JUCE doesn't, so plugins would stay stuck in "playing".
            // Snapshot the canonical payload BEFORE stop() resets _pos
            // to 0, then emit AFTER stop completes. Mirrors the HTML5
            // pause contract via _songEventPayload (audioT/chartT/perfNow).
            const payload = _songEventPayload();
            const wasPlaying = isPlaying;
            await jucePlayer.stop().catch(() => {});
            if (wasPlaying && window.slopsmith) {
                window.slopsmith.isPlaying = false;
                window.slopsmith.emit('song:pause', payload);
            }
            window._juceMode = false;
            window._juceAudioUrl = null;
        }
        if (hadPlayableSong) window.slopsmith.emit('song:stop', { time: stopTime || 0, screen: id });
        audio.pause();
        audio.src = '';
        window._currentSongAudio = null;
        // Reloading any song later should get a fresh JUCE routing attempt.
        window._clearJuceRerouteMemo?.();
        isPlaying = false;
        setPlayButtonState(false);
    }
    window.scrollTo(0, 0);
    if (window.slopsmith) window.slopsmith.emit('screen:changed', { id });
}

// ── Library ──────────────────────────────────────────────────────────────

// Persist the view toggle (grid vs tree), sort selection, and format
// filter across reloads. Stored as separate keys (rather than one
// blob) so future controls can opt in independently and a corrupted
// single value doesn't wipe the rest. Validation lives at the read
// site — we coerce unknown values back to safe defaults rather than
// trusting whatever happens to be in localStorage.
const _LIB_VIEW_KEY = 'slopsmith.libView';
const _LIB_SORT_KEY = 'slopsmith.libSort';
const _LIB_FORMAT_KEY = 'slopsmith.libFormat';
const _LIB_PROVIDER_KEY = 'slopsmith.libProvider';
const _LIB_VIEW_VALUES = new Set(['grid', 'tree']);
const _LIB_SORT_VALUES = new Set([
    'artist', 'artist-desc', 'title', 'title-desc',
    'recent', 'year-desc', 'year', 'tuning',
]);
const _LIB_FORMAT_VALUES = new Set(['', 'psarc', 'sloppak', 'loose']);
// Tree-view expand/collapse persistence. Three states per tree:
//   '1'  → user asked to expand all
//   '0'  → user asked to collapse all
//   null → no explicit choice; renderTreeInto's existing heuristic
//          (auto-open when search active or few artists) wins
//
// Library and Favorites are separate trees with separate
// Expand/Collapse buttons, so each gets its own key — toggling one
// must not flip the other's persisted state.
const _LIB_TREE_EXPAND_KEY = 'slopsmith.libTreeExpand';
const _FAV_TREE_EXPAND_KEY = 'slopsmith.favTreeExpand';
const _LIB_TREE_EXPAND_VALUES = new Set(['1', '0']);

function _readPersistedChoice(key, allowed, fallback) {
    try {
        const v = localStorage.getItem(key);
        return v !== null && allowed.has(v) ? v : fallback;
    } catch {
        return fallback;
    }
}
function _writePersistedChoice(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode / quota */ }
}

function _libraryProviderApi() {
    const api = window.slopsmith && window.slopsmith.libraryProviders;
    return api && typeof api === 'object' ? api : null;
}

function _libraryProviderSnapshot() {
    const api = _libraryProviderApi();
    if (api && typeof api.snapshot === 'function') return api.snapshot();
    return { available: false, current: 'local', providers: [{ id: 'local', label: 'My Library', kind: 'local', capabilities: ['library.read', 'art.read', 'song.play'], default: true }] };
}

function _providerById(providerId) {
    const api = _libraryProviderApi();
    if (api && typeof api.providerById === 'function') return api.providerById(providerId);
    return (_libraryProviderSnapshot().providers || []).find(provider => provider.id === providerId) || null;
}

function _activeLibraryProvider() {
    const api = _libraryProviderApi();
    if (api && typeof api.activeProvider === 'function') return api.activeProvider();
    const snapshot = _libraryProviderSnapshot();
    return _providerById(snapshot.current) || _providerById('local') || (snapshot.providers || [])[0];
}

function _activeLibraryProviderId() {
    const api = _libraryProviderApi();
    if (api && typeof api.activeProviderId === 'function') return api.activeProviderId();
    return (_activeLibraryProvider() || {}).id || 'local';
}

function _isLocalLibraryProvider(providerId) {
    const api = _libraryProviderApi();
    if (api && typeof api.isLocal === 'function') return api.isLocal(providerId);
    const provider = _providerById(providerId);
    return providerId === 'local' || (provider && provider.kind === 'local');
}

function _providerSupports(providerId, capability) {
    const api = _libraryProviderApi();
    if (api && typeof api.supports === 'function') return api.supports(providerId, capability);
    const provider = _providerById(providerId);
    return !!provider && Array.isArray(provider.capabilities) && provider.capabilities.includes(capability);
}

function _applyLibraryProviderToParams(params) {
    params.set('provider', _activeLibraryProviderId());
    return params;
}

function _resetLibraryProviderViewState() {
    _libEpoch++;
    currentPage = 0;
    _treePage = 0;
    _treeStats = null;
    _tuningNames = null;
    stopInfiniteScroll();
}

function _renderLibraryProviderSelector() {
    const select = document.getElementById('lib-provider');
    const title = document.getElementById('lib-title');
    const activeProvider = _activeLibraryProvider();
    const providers = _libraryProviderSnapshot().providers || [];
    if (select) {
        select.innerHTML = providers.map(provider =>
            `<option value="${_escAttr(provider.id)}">${esc(provider.label || provider.id)}</option>`
        ).join('');
        select.value = activeProvider.id;
        select.classList.toggle('hidden', providers.length <= 1);
    }
    if (title) title.textContent = activeProvider.id === 'local' ? 'Your Library' : (activeProvider.label || activeProvider.id);
}

async function loadLibraryProviders({ restoreSaved = false, reloadOnChange = false } = {}) {
    const beforeProviderId = _activeLibraryProviderId();
    const api = _libraryProviderApi();
    if (api && typeof api.refresh === 'function') {
        await api.refresh({ restoreSaved });
    }

    _renderLibraryProviderSelector();
    const afterProviderId = _activeLibraryProviderId();
    if (reloadOnChange && afterProviderId !== beforeProviderId) {
        _resetLibraryProviderViewState();
        loadLibrary(0);
    }
}

async function setLibraryProvider(providerId, options = {}) {
    const beforeProviderId = _activeLibraryProviderId();
    try {
        const capabilityApi = window.slopsmith && window.slopsmith.capabilities;
        if (capabilityApi && typeof capabilityApi.command === 'function') {
            await capabilityApi.command('library', 'select-provider', {
                requester: 'app.library',
                target: { providerId },
                payload: options && typeof options === 'object' ? options : {},
            });
        } else {
            _libraryProviderApi()?.select?.(String(providerId || ''));
        }
    } catch (err) {
        // Reached from an inline onchange="setLibraryProvider(this.value)"
        // handler that does not await us, so a rejection would otherwise
        // surface as an unhandled promise rejection. Log and bail without a
        // reload. Re-render the selector so the <select> snaps back to the
        // still-active provider — the onchange already moved its displayed
        // value to the (failed) selection, which would otherwise leave the
        // dropdown showing a provider that was never actually selected.
        console.error('setLibraryProvider: failed to select provider', providerId, err);
        _renderLibraryProviderSelector();
        return;
    }
    if (beforeProviderId === _activeLibraryProviderId()) {
        // The active provider didn't change — either a genuine no-op, or the
        // capability command degraded/no-op'd without throwing (e.g. an
        // unknown provider returns a "degraded" outcome rather than rejecting).
        // The inline onchange already moved the <select>'s displayed value, so
        // re-render to snap it back to the provider that is actually active.
        _renderLibraryProviderSelector();
        return;
    }
    _renderLibraryProviderSelector();
    _resetLibraryProviderViewState();
    loadLibrary(0);
}

function _libraryProviderIdForSong(song, fallbackProviderId) {
    return String(
        song.provider_id || song.providerId || song.library_provider_id ||
        song.libraryProviderId || song.provider || fallbackProviderId || 'local'
    );
}

function _librarySongId(song) {
    const songId = song.song_id || song.songId || song.remote_id || song.remoteId || song.id || song.filename || '';
    return String(songId || '');
}

function _libraryLocalFilename(song, providerId) {
    if (_isLocalLibraryProvider(providerId)) return song.filename ? String(song.filename) : '';
    const filename = song.local_filename || song.localFilename || song.synced_filename ||
        song.syncedFilename || song.play_filename || song.playFilename || '';
    if (filename) return String(filename);
    const state = _librarySyncState(providerId, _librarySongId(song));
    return state && state.status === 'synced' && state.localFilename ? String(state.localFilename) : '';
}

function _libraryDisplayFilename(song, providerId) {
    return _libraryLocalFilename(song, providerId) || _librarySongId(song) || 'Unknown song';
}

function _librarySongTitle(song, providerId) {
    const fallback = _libraryDisplayFilename(song, providerId);
    return song.title || fallback.replace(/_p\.psarc$/i, '').replace(/_/g, ' ');
}

function _librarySongArtUrl(song, providerId) {
    const explicitArt = song.art_url || song.artUrl || song.cover_url || song.coverUrl;
    if (explicitArt) return _safeImageUrl(explicitArt);
    const version = song.mtime ? `?v=${Math.floor(song.mtime)}` : '';
    const localFilename = _libraryLocalFilename(song, providerId);
    if (localFilename) return `/api/song/${encodeURIComponent(localFilename)}/art${version}`;
    if (_isLocalLibraryProvider(providerId)) return '';
    if (!_providerSupports(providerId, 'art.read')) return '';
    const songId = _librarySongId(song);
    return songId ? `/api/library/providers/${encodeURIComponent(providerId)}/songs/${encodeURIComponent(songId)}/art${version}` : '';
}

function _safeImageUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        const parsed = new URL(raw, window.location.origin);
        return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
    } catch {
        return '';
    }
}

const _librarySyncStates = new Map();

function _librarySyncKey(providerId, songId) {
    // JSON.stringify avoids delimiter collision: a newline in either value
    // would make "${p}\n${s}" ambiguous, but JSON-serialised arrays are
    // always distinct for distinct (providerId, songId) pairs.
    return JSON.stringify([providerId, songId]);
}

function _librarySyncState(providerId, songId) {
    return _librarySyncStates.get(_librarySyncKey(providerId, songId)) || null;
}

function _librarySyncStatusText(state) {
    if (!state) return '';
    if (state.status === 'syncing') return 'Loading package...';
    if (state.status === 'synced') return state.message || 'Ready to play';
    if (state.status === 'error') return state.message ? `Load failed: ${state.message}` : 'Load failed';
    return '';
}

function _librarySyncStatusClass(state, layout) {
    const base = layout === 'inline'
        ? 'library-sync-status inline-block text-[11px] ml-1'
        : 'library-sync-status block mt-1 text-[11px] leading-snug';
    if (!state) return `${base} hidden text-gray-500`;
    if (state.status === 'error') return `${base} text-red-300`;
    if (state.status === 'synced') return `${base} text-green-300`;
    return `${base} text-gray-400`;
}

function _librarySyncStatusMarkup(providerId, songId, layout = 'block') {
    const state = _librarySyncState(providerId, songId);
    return `<span data-library-sync-status role="status" aria-live="polite" data-library-sync-provider="${encodeURIComponent(providerId)}" data-library-sync-song="${encodeURIComponent(songId)}" class="${_librarySyncStatusClass(state, layout)}">${esc(_librarySyncStatusText(state))}</span>`;
}

let libView = _readPersistedChoice(_LIB_VIEW_KEY, _LIB_VIEW_VALUES, 'grid');
let currentPage = 0;
const PAGE_SIZE = 24;
// Tree letter selection persists across reloads / coming back from
// the player so the user lands on the same alphabet group they
// picked. Validation: any single uppercase letter, or `#` for
// non-alphabetical artists, or `''` for the All bucket.
const _LIB_TREE_LETTER_KEY = 'slopsmith.libTreeLetter';
const _FAV_TREE_LETTER_KEY = 'slopsmith.favTreeLetter';
function _readPersistedLetter(key) {
    let v = null;
    try { v = localStorage.getItem(key); } catch { return ''; }
    if (v === null) return '';
    return (v === '' || v === '#' || /^[A-Z]$/.test(v)) ? v : '';
}
function _writePersistedLetter(key, value) {
    try { localStorage.setItem(key, value || ''); } catch { /* private mode / quota */ }
}
let _treeLetter = _readPersistedLetter(_LIB_TREE_LETTER_KEY);
let _treeStats = null;
let _debounceTimer = null;
let _loadingMore = false;
let _hasMore = true;
let _gridObserver = null;
// Bumped on filter/sort/view changes so in-flight page fetches can detect
// they've been superseded and skip rendering stale results.
let _libEpoch = 0;

// ── Library filters (slopsmith#129/#69) ────────────────────────────────
//
// Filter state lives in a single object so the active set can be
// serialized to localStorage as one key. Each axis is OR-within (Lead
// + Rhythm = "has Lead OR Rhythm"); cross-axis is AND. Tri-state pills
// translate to `_has` / `_lacks` lists on the wire so the server's
// SQL doesn't have to encode the third "any" state.
// In smart mode Combo is subsumed into Lead; only show Lead/Rhythm/Bass.
// In legacy mode keep the original four values.
// In-memory cache so a localStorage.setItem failure (private mode / quota /
// disabled storage) still keeps the chosen mode for the rest of the session.
// Initialised lazily from localStorage on first read.
let _arrangementNamingMode = null;
function _getArrangementNamingMode() {
    if (_arrangementNamingMode === 'smart' || _arrangementNamingMode === 'legacy') {
        return _arrangementNamingMode;
    }
    try {
        _arrangementNamingMode = localStorage.getItem('arrangementNamingMode') === 'legacy' ? 'legacy' : 'smart';
    } catch (_) {
        _arrangementNamingMode = 'smart';
    }
    return _arrangementNamingMode;
}
// In smart mode 'Combo' is subsumed into 'Lead' (_ensure_smart_names maps it
// the same way). Normalize any persisted 'Combo' tokens before querying or
// rendering so the UI and the server stay in sync.
function _toSmartArrs(arr) {
    return arr.map(a => a === 'Combo' ? 'Lead' : a);
}
function _onNamingModeChange(value) {
    const mode = value === 'legacy' ? 'legacy' : 'smart';
    _arrangementNamingMode = mode;
    try { localStorage.setItem('arrangementNamingMode', mode); } catch (_) {}
    if (mode === 'smart') {
        _libFilters.arrHas   = _toSmartArrs(_libFilters.arrHas);
        _libFilters.arrLacks = _toSmartArrs(_libFilters.arrLacks);
        _saveLibFilters();
    }
    _renderLibFilterDrawer();
    _renderLibFilterChips();
    _libEpoch++;
    currentPage = 0;
    _treeStats = null;
    loadLibrary(0);
}
function _getArrangements() {
    return _getArrangementNamingMode() === 'smart'
        ? ['Lead', 'Rhythm', 'Bass']
        : ['Lead', 'Rhythm', 'Bass', 'Combo'];
}
function _arrangementBadgeHtml(arrangement, nm) {
    const label = (nm === 'smart' && arrangement.smart_name) ? arrangement.smart_name : arrangement.name;
    const cls = label.includes('Lead')   ? 'bg-red-900/40 text-red-300' :
                label.includes('Rhythm') ? 'bg-blue-900/40 text-blue-300' :
                label.includes('Bass')   ? 'bg-green-900/40 text-green-300' :
                'bg-dark-600 text-gray-400';
    return `<span class="px-1.5 py-0.5 rounded ${cls}">${esc(label)}</span>`;
}
// Stem ids match the bare strings sloppak manifests use ("drums",
// "bass", etc.). `full` is intentionally omitted from the filter UI:
// it's the fallback mix every sloppak ships with, so filtering by it
// would match all sloppaks and confuse users.
const _STEM_DEFS = [
    { id: 'drums', label: 'Drums' },
    { id: 'bass', label: 'Bass' },
    { id: 'vocals', label: 'Vocals' },
    { id: 'guitar', label: 'Guitar' },
    { id: 'piano', label: 'Piano' },
    { id: 'other', label: 'Other' },
];
const _LIB_FILTERS_KEY = 'slopsmith.libFilters';
let _libFilters = _loadLibFilters();
let _tuningNames = null;  // cached from /api/library/tuning-names

function _defaultLibFilters() {
    return {
        arrHas: [], arrLacks: [],
        stemsHas: [], stemsLacks: [],
        lyrics: null,             // null | 1 | 0
        tunings: [],
    };
}

function _normalizeStringArray(v) {
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
}

function _normalizeLibFilters(parsed) {
    // Defensive: a stale or hand-edited localStorage payload could have
    // any shape. Without normalization a later `.join` or `.includes`
    // on a non-array would throw at filter-apply time. Coerce each
    // field back to its expected type, dropping anything we don't
    // recognize. Slopsmith#134 review.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return _defaultLibFilters();
    }
    const lyrics = parsed.lyrics;
    return {
        arrHas: _normalizeStringArray(parsed.arrHas),
        arrLacks: _normalizeStringArray(parsed.arrLacks),
        stemsHas: _normalizeStringArray(parsed.stemsHas),
        stemsLacks: _normalizeStringArray(parsed.stemsLacks),
        lyrics: lyrics === 0 || lyrics === 1 ? lyrics : null,
        tunings: _normalizeStringArray(parsed.tunings),
    };
}

function _loadLibFilters() {
    try {
        const raw = localStorage.getItem(_LIB_FILTERS_KEY);
        if (!raw) return _defaultLibFilters();
        const filters = _normalizeLibFilters(JSON.parse(raw));
        // Normalize any stale 'Combo' tokens left from legacy-mode sessions.
        if (_getArrangementNamingMode() === 'smart') {
            filters.arrHas   = _toSmartArrs(filters.arrHas);
            filters.arrLacks = _toSmartArrs(filters.arrLacks);
        }
        return filters;
    } catch {
        return _defaultLibFilters();
    }
}

function _saveLibFilters() {
    try { localStorage.setItem(_LIB_FILTERS_KEY, JSON.stringify(_libFilters)); }
    catch { /* private mode / quota — ignore, in-memory state still works */ }
}

function _libActiveCount() {
    let n = 0;
    if (_libFilters.arrHas.length) n++;
    if (_libFilters.arrLacks.length) n++;
    if (_libFilters.stemsHas.length) n++;
    if (_libFilters.stemsLacks.length) n++;
    if (_libFilters.lyrics !== null) n++;
    if (_libFilters.tunings.length) n++;
    return n;
}

function _applyLibFiltersToParams(params) {
    const nm = _getArrangementNamingMode();
    params.set('naming_mode', nm);
    const arrHas   = nm === 'smart' ? _toSmartArrs(_libFilters.arrHas)   : _libFilters.arrHas;
    const arrLacks = nm === 'smart' ? _toSmartArrs(_libFilters.arrLacks) : _libFilters.arrLacks;
    if (arrHas.length)   params.set('arrangements_has',   arrHas.join(','));
    if (arrLacks.length) params.set('arrangements_lacks', arrLacks.join(','));
    if (_libFilters.stemsHas.length) params.set('stems_has', _libFilters.stemsHas.join(','));
    if (_libFilters.stemsLacks.length) params.set('stems_lacks', _libFilters.stemsLacks.join(','));
    if (_libFilters.lyrics !== null) params.set('has_lyrics', String(_libFilters.lyrics));
    if (_libFilters.tunings.length) params.set('tunings', _libFilters.tunings.join(','));
    return params;
}

function _pillState(item, hasList, lacksList) {
    if (hasList.includes(item)) return 'require';
    if (lacksList.includes(item)) return 'exclude';
    return 'any';
}

function _cyclePill(item, hasKey, lacksKey) {
    // Cycle: any -> require -> exclude -> any. Mutates _libFilters in place.
    const hasList = _libFilters[hasKey];
    const lacksList = _libFilters[lacksKey];
    const inHas = hasList.indexOf(item);
    const inLacks = lacksList.indexOf(item);
    if (inHas === -1 && inLacks === -1) {
        hasList.push(item);
    } else if (inHas !== -1) {
        hasList.splice(inHas, 1);
        lacksList.push(item);
    } else {
        lacksList.splice(inLacks, 1);
    }
    _saveLibFilters();
    _renderLibFilterDrawer();
    _renderLibFilterChips();
    _libEpoch++;
    currentPage = 0;
    _treeStats = null;  // letter bar counts depend on filters now
    loadLibrary(0);
}

function _renderPillRow(containerId, items, hasKey, lacksKey, labelFor) {
    const c = document.getElementById(containerId);
    if (!c) return;
    c.innerHTML = '';
    for (const it of items) {
        const id = typeof it === 'string' ? it : it.id;
        const label = labelFor ? labelFor(it) : id;
        const state = _pillState(id, _libFilters[hasKey], _libFilters[lacksKey]);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `filter-pill state-${state}`;
        btn.textContent = label;
        btn.onclick = () => _cyclePill(id, hasKey, lacksKey);
        c.appendChild(btn);
    }
}

function _renderLyricsPill() {
    // Single tri-state pill matching the arrangement / stem pattern.
    // Cycle: any (null) -> require (1) -> exclude (0) -> any.
    const c = document.getElementById('filter-lyrics');
    if (!c) return;
    c.innerHTML = '';
    const v = _libFilters.lyrics;
    const state = v === 1 ? 'require' : v === 0 ? 'exclude' : 'any';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `filter-pill state-${state}`;
    btn.textContent = 'Lyrics';
    btn.onclick = () => {
        _libFilters.lyrics = v === null ? 1 : v === 1 ? 0 : null;
        _saveLibFilters();
        _renderLyricsPill();
        _renderLibFilterChips();
        _libEpoch++;
        currentPage = 0;
        _treeStats = null;
        loadLibrary(0);
    };
    c.appendChild(btn);
}

async function _renderTuningList() {
    const c = document.getElementById('filter-tunings');
    if (!c) return;
    let fetchError = null;
    if (!_tuningNames) {
        const myEpoch = _libEpoch;
        c.innerHTML = '<div class="text-xs text-gray-500 px-2">Loading...</div>';
        try {
            const params = _applyLibraryProviderToParams(new URLSearchParams());
            const resp = await fetch(`/api/library/tuning-names?${params}`);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            // Guard against a provider switch that invalidated _tuningNames
            // while this request was in flight — discard a stale result.
            if (myEpoch !== _libEpoch) return;
            _tuningNames = Array.isArray(data.tunings) ? data.tunings : [];
        } catch (e) {
            if (myEpoch !== _libEpoch) return;
            // Distinguish a server / network failure from "the DB
            // genuinely has no tunings indexed". The latter wants a
            // Full Rescan; the former just wants a retry. Don't cache
            // the failure — leave _tuningNames null so reopening the
            // drawer triggers a fresh attempt.
            _tuningNames = null;
            fetchError = e.message || 'request failed';
        }
    }
    c.innerHTML = '';
    if (fetchError) {
        c.innerHTML = `<div class="text-xs text-red-400 px-2">Failed to load tunings (${esc(fetchError)}). Reopen the drawer to retry.</div>`;
        return;
    }
    if (!_tuningNames.length) {
        c.innerHTML = '<div class="text-xs text-gray-500 px-2">No tunings indexed yet — try Full Rescan.</div>';
        return;
    }
    for (const t of _tuningNames) {
        const checked = _libFilters.tunings.includes(t.name);
        const row = document.createElement('label');
        row.className = 'tuning-row';
        row.innerHTML =
            `<input type="checkbox" ${checked ? 'checked' : ''} class="rounded border-gray-600 bg-dark-700 text-accent">` +
            `<span class="flex-1">${esc(t.name)}</span>` +
            `<span class="tuning-count">${t.count}</span>`;
        const cb = row.querySelector('input');
        cb.onchange = () => {
            const i = _libFilters.tunings.indexOf(t.name);
            if (cb.checked && i === -1) _libFilters.tunings.push(t.name);
            else if (!cb.checked && i !== -1) _libFilters.tunings.splice(i, 1);
            _saveLibFilters();
            _updateLibFiltersBadge();
            _renderLibFilterChips();
            _renderTuningSummary();
            _libEpoch++;
            currentPage = 0;
            _treeStats = null;
            loadLibrary(0);
        };
        c.appendChild(row);
    }
    _renderTuningSummary();
}

function _renderTuningSummary() {
    const s = document.getElementById('filter-tunings-summary');
    if (!s) return;
    if (!_libFilters.tunings.length) { s.textContent = 'All tunings'; return; }
    if (_libFilters.tunings.length === 1) { s.textContent = _libFilters.tunings[0]; return; }
    s.textContent = `${_libFilters.tunings[0]} +${_libFilters.tunings.length - 1}`;
}

function _updateLibFiltersBadge() {
    const badge = document.getElementById('lib-filters-count');
    if (!badge) return;
    const n = _libActiveCount();
    badge.textContent = String(n);
    badge.classList.toggle('hidden', n === 0);
}

function _renderLibFilterDrawer() {
    _renderPillRow('filter-arrangements', _getArrangements(), 'arrHas', 'arrLacks');
    _renderPillRow('filter-stems', _STEM_DEFS, 'stemsHas', 'stemsLacks', s => s.label);
    _renderLyricsPill();
    // Stems section dimmed when format=psarc (no stems exist).
    const stemsSection = document.getElementById('filter-stems-section');
    if (stemsSection) {
        const fmt = (document.getElementById('lib-format') || {}).value || '';
        stemsSection.classList.toggle('opacity-40', fmt === 'psarc');
        stemsSection.classList.toggle('pointer-events-none', fmt === 'psarc');
    }
    _updateLibFiltersBadge();
}

function _renderLibFilterChips() {
    const row = document.getElementById('lib-filter-chips');
    if (!row) return;
    const chips = [];
    for (const a of _libFilters.arrHas) chips.push({ label: a, kind: 'require', remove: () => _libFilters.arrHas = _libFilters.arrHas.filter(x => x !== a) });
    for (const a of _libFilters.arrLacks) chips.push({ label: `no ${a}`, kind: 'exclude', remove: () => _libFilters.arrLacks = _libFilters.arrLacks.filter(x => x !== a) });
    for (const s of _libFilters.stemsHas) {
        const def = _STEM_DEFS.find(d => d.id === s);
        chips.push({ label: def ? def.label : s, kind: 'require', remove: () => _libFilters.stemsHas = _libFilters.stemsHas.filter(x => x !== s) });
    }
    for (const s of _libFilters.stemsLacks) {
        const def = _STEM_DEFS.find(d => d.id === s);
        chips.push({ label: `no ${def ? def.label : s}`, kind: 'exclude', remove: () => _libFilters.stemsLacks = _libFilters.stemsLacks.filter(x => x !== s) });
    }
    if (_libFilters.lyrics === 1) chips.push({ label: 'has lyrics', kind: 'require', remove: () => _libFilters.lyrics = null });
    if (_libFilters.lyrics === 0) chips.push({ label: 'no lyrics', kind: 'exclude', remove: () => _libFilters.lyrics = null });
    for (const t of _libFilters.tunings) chips.push({ label: t, kind: 'require', remove: () => _libFilters.tunings = _libFilters.tunings.filter(x => x !== t) });

    row.innerHTML = '';
    if (!chips.length) {
        row.classList.add('hidden');
        return;
    }
    row.classList.remove('hidden');
    for (const c of chips) {
        const el = document.createElement('span');
        el.className = `chip ${c.kind === 'exclude' ? 'chip-exclude' : ''}`;
        // The "×" glyph isn't a reliable accessible name; assistive tech
        // also can't depend on `title` alone. Spell out the action plus
        // the chip's label in `aria-label` so screen-reader users hear
        // "Remove filter: Lead" instead of "button" or just "×".
        const ariaLabel = `Remove filter: ${c.label}`;
        el.innerHTML =
            `${esc(c.label)}<button type="button" title="${esc(ariaLabel)}" aria-label="${esc(ariaLabel)}">×</button>`;
        el.querySelector('button').onclick = () => {
            c.remove();
            _saveLibFilters();
            _renderLibFilterDrawer();
            _renderLibFilterChips();
            _libEpoch++;
            currentPage = 0;
            _treeStats = null;
            loadLibrary(0);
        };
        row.appendChild(el);
    }
}

function toggleLibFilters(force) {
    const drawer = document.getElementById('lib-filter-drawer');
    const overlay = document.getElementById('lib-filter-overlay');
    if (!drawer) return;
    const open = force === undefined ? !drawer.classList.contains('open') : !!force;
    drawer.classList.toggle('open', open);
    overlay.classList.toggle('hidden', !open);
    if (open) {
        _renderLibFilterDrawer();
        _renderTuningList();
    }
}

function clearLibFilters() {
    _libFilters = _defaultLibFilters();
    _saveLibFilters();
    _renderLibFilterDrawer();
    _renderTuningList();
    _renderLibFilterChips();
    _libEpoch++;
    currentPage = 0;
    _treeStats = null;
    loadLibrary(0);
}

function setLibView(view) {
    libView = view;
    if (_LIB_VIEW_VALUES.has(view)) _writePersistedChoice(_LIB_VIEW_KEY, view);
    document.getElementById('lib-grid').classList.toggle('hidden', view !== 'grid');
    document.getElementById('lib-tree').classList.toggle('hidden', view !== 'tree');
    document.querySelectorAll('.lib-grid-ctrl').forEach(el => el.classList.toggle('hidden', view !== 'grid'));
    document.querySelectorAll('.lib-tree-ctrl').forEach(el => el.classList.toggle('hidden', view !== 'tree'));
    document.getElementById('view-grid-btn').className = `px-3 py-2.5 text-sm transition ${view === 'grid' ? 'text-accent-light' : 'text-gray-600 hover:text-gray-400'}`;
    document.getElementById('view-tree-btn').className = `px-3 py-2.5 text-sm transition ${view === 'tree' ? 'text-accent-light' : 'text-gray-600 hover:text-gray-400'}`;
    if (view !== 'grid') stopInfiniteScroll();
    _libEpoch++;
    // View toggle changes which container `_libNavItems` resolves
    // to (tree vs grid) — drop the cache so the next keypress
    // re-derives.
    _bumpLibNavGeneration();
    loadLibrary();
}

async function loadLibrary(page) {
    if (libView === 'grid') {
        await loadGridPage(page !== undefined ? page : currentPage);
    } else {
        await loadTreeView();
    }
}

async function _fetchJsonOrThrow(url) {
    const resp = await fetch(url);
    const raw = await resp.text();
    let data = {};
    let parseError = null;
    if (raw) {
        try {
            data = JSON.parse(raw);
        } catch (error) {
            parseError = error;
        }
    }
    if (!resp.ok) {
        const detail = String(data.detail || data.error || data.message || '').trim();
        throw new Error(detail || `HTTP ${resp.status}`);
    }
    if (parseError) throw new Error('Malformed JSON response');
    return data;
}

function _setLibraryOfflineMessage(containerId, countId, message) {
    const container = document.getElementById(containerId);
    const count = document.getElementById(countId);
    if (count) count.textContent = 'Source appears offline';
    if (container) {
        container.innerHTML = `<div class="rounded-xl border border-red-900/30 bg-red-900/10 px-4 py-6 text-sm text-red-300">${esc(message || 'This source appears to be offline.')}</div>`;
    }
}

function _setLibraryLoadingMessage(containerId, countId, message) {
    const container = document.getElementById(containerId);
    const count = document.getElementById(countId);
    if (count) count.textContent = 'Loading source...';
    if (container) {
        container.innerHTML = `<div class="rounded-xl border border-gray-800/50 bg-dark-700/30 px-4 py-6 text-sm text-gray-300">${esc(message || 'Loading library...')}</div>`;
    }
}

function _libraryLoadingText() {
    const provider = _activeLibraryProvider();
    if (!provider || provider.id === 'local' || provider.kind === 'local') {
        return 'Loading library...';
    }
    return `Connecting to ${provider.label || provider.id}...`;
}

function filterLibrary() {
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(() => {
        _libEpoch++;
        currentPage = 0;
        _treeLetter = '';
        // Letter-bar counts depend on `q` and the active filter set —
        // any change to those must invalidate the tree-view stats
        // cache or the next switch to tree view will render stale
        // letter counts (slopsmith#134 review).
        _treeStats = null;
        loadLibrary(0);
    }, 250);
}

function sortLibrary() {
    // Persist whichever of the two dropdowns just changed so the next
    // page load can restore both. Both selects route through this
    // handler today; reading both is cheap and keeps the function
    // single-purpose.
    const sortEl = document.getElementById('lib-sort');
    if (sortEl && _LIB_SORT_VALUES.has(sortEl.value)) {
        _writePersistedChoice(_LIB_SORT_KEY, sortEl.value);
    }
    const fmtEl = document.getElementById('lib-format');
    if (fmtEl && _LIB_FORMAT_VALUES.has(fmtEl.value)) {
        _writePersistedChoice(_LIB_FORMAT_KEY, fmtEl.value);
    }
    _libEpoch++;
    currentPage = 0;
    // Same reason as filterLibrary: format dropdown changes the stats
    // payload, so the cache must drop too.
    _treeStats = null;
    loadLibrary(0);
}

// ── Grid View (server-side pagination, infinite scroll) ────────────────

async function loadGridPage(page = 0) {
    const myEpoch = _libEpoch;
    const q = document.getElementById('lib-filter').value.trim();
    const sort = document.getElementById('lib-sort').value;
    const format = (document.getElementById('lib-format') || {}).value || '';
    const params = new URLSearchParams({ q, page, size: PAGE_SIZE, sort });
    if (format) params.set('format', format);
    _applyLibraryProviderToParams(params);
    _applyLibFiltersToParams(params);
    if (page === 0) {
        _setLibraryLoadingMessage('lib-grid', 'lib-count', _libraryLoadingText());
    }
    let data;
    try {
        data = await _fetchJsonOrThrow(`/api/library?${params}`);
    } catch (error) {
        if (myEpoch !== _libEpoch) return;
        currentPage = 0;
        _hasMore = false;
        stopInfiniteScroll();
        _setLibraryOfflineMessage('lib-grid', 'lib-count', error.message || 'This source appears to be offline.');
        return;
    }
    if (myEpoch !== _libEpoch) return; // filter/sort/view changed mid-fetch

    currentPage = page;
    const total = data.total || 0;
    const songs = data.songs || [];
    document.getElementById('lib-count').textContent = `${total} songs`;

    renderGridCards(songs, 'lib-grid', page === 0 ? 'replace' : 'append');

    _hasMore = (page + 1) * PAGE_SIZE < total;
    setupInfiniteScroll();
}

function setupInfiniteScroll() {
    let sentinel = document.getElementById('lib-grid-sentinel');
    if (!sentinel) {
        sentinel = document.createElement('div');
        sentinel.id = 'lib-grid-sentinel';
        sentinel.style.height = '1px';
        document.getElementById('lib-grid').after(sentinel);
    }
    stopInfiniteScroll();
    if (!_hasMore) return;
    _gridObserver = new IntersectionObserver(async (entries) => {
        if (entries[0].isIntersecting && !_loadingMore && _hasMore) {
            _loadingMore = true;
            try { await loadGridPage(currentPage + 1); }
            finally { _loadingMore = false; }
        }
    }, { rootMargin: '400px' });
    _gridObserver.observe(sentinel);
}

function stopInfiniteScroll() {
    if (_gridObserver) {
        _gridObserver.disconnect();
        _gridObserver = null;
    }
}

function formatBadge(fmt, stemCount) {
    if (fmt === 'sloppak' && (stemCount || 0) > 1) {
        return `<span class="fmt-badge absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-900/80 text-purple-200 border border-purple-700">STEMS</span>`;
    }
    if (fmt === 'sloppak') {
        return `<span class="fmt-badge absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-900/80 text-green-200 border border-green-700">SLOPPAK</span>`;
    }
    if (fmt === 'loose') {
        return `<span class="fmt-badge absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-900/80 text-amber-200 border border-amber-700">FOLDER</span>`;
    }
    return `<span class="fmt-badge absolute top-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-900/80 text-blue-200 border border-blue-700">PSARC</span>`;
}

function formatBadgeInline(fmt, stemCount) {
    if (fmt === 'sloppak' && (stemCount || 0) > 1) {
        return `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-900/60 text-purple-300">STEMS</span>`;
    }
    if (fmt === 'sloppak') {
        return `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-green-900/60 text-green-300">SLOPPAK</span>`;
    }
    if (fmt === 'loose') {
        return `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-900/60 text-amber-300">FOLDER</span>`;
    }
    return `<span class="px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-900/60 text-blue-300">PSARC</span>`;
}

function renderGridCards(songs, containerId = 'lib-grid', mode = 'replace') {
    const grid = document.getElementById(containerId);
    const screenProviderId = containerId.startsWith('fav') ? 'local' : _activeLibraryProviderId();
    const html = songs.map(song => {
        const providerId = _libraryProviderIdForSong(song, screenProviderId);
        const localFilename = _libraryLocalFilename(song, providerId);
        const songId = _librarySongId(song);
        const title = _librarySongTitle(song, providerId);
        const artist = song.artist || '';
        const duration = song.duration ? formatTime(song.duration) : '';
        const tuning = song.tuning || '';
        const artUrl = _librarySongArtUrl(song, providerId);
        const isLocalProvider = _isLocalLibraryProvider(providerId);
        const isSloppak = song.format === 'sloppak';
        const stdRetune = isLocalProvider && localFilename && !isSloppak && tuning && !song.has_estd &&
            ['Eb Standard', 'D Standard', 'C# Standard', 'C Standard'].includes(tuning);
        const retuneBtn = stdRetune
            ? `<button data-retune="${encodeURIComponent(localFilename)}" data-title="${encodeURIComponent(title)}" data-tuning="${_escAttr(tuning)}" data-target="E Standard"
                class="retune-btn mt-2 w-full px-2 py-1.5 bg-gold/10 hover:bg-gold/20 border border-gold/20 rounded-lg text-xs font-medium text-gold transition">
                ⬆ Convert to E Standard</button>`
            : '';
        const fmtBadge = formatBadge(song.format, song.stem_count);
        const syncStatus = !localFilename ? _librarySyncStatusMarkup(providerId, songId) : '';
        const actionButtons = isLocalProvider && localFilename
            ? `${editBtn(song)}${heartBtn(localFilename, song.favorite)}`
            : '';
        const canSync = !localFilename && _providerSupports(providerId, 'song.sync');
        const isInteractive = !!localFilename || canSync;
        const providerAttr = `data-library-provider="${encodeURIComponent(providerId)}"`;
        // For provider-backed entries, keep data-library-song alongside
        // data-play once the song is synced so _restoreLibSelection can
        // still match the persisted remote selection after a re-render.
        const songAttr = !isLocalProvider ? ` data-library-song="${encodeURIComponent(songId)}"` : '';
        const entryAttrs = localFilename
            ? `data-play="${encodeURIComponent(localFilename)}" ${providerAttr}${songAttr}`
            : `data-library-provider="${encodeURIComponent(providerId)}" data-library-song="${encodeURIComponent(songId)}"`;
        const ariaAction = localFilename ? 'Play' : 'Load and play';
        const ariaLabel = `${ariaAction} ${title || _libraryDisplayFilename(song, providerId)}${artist ? ' by ' + artist : ''}`;
        const displayLabel = `${title || _libraryDisplayFilename(song, providerId)}${artist ? ' by ' + artist : ''}`;
        const interactiveAttrs = isInteractive
            ? `tabindex="0" role="button" aria-label="${_escAttr(ariaLabel)}"`
            : `role="listitem" aria-label="${_escAttr(displayLabel)}"`;
        const artHtml = artUrl
            ? `<img src="${_escAttr(artUrl)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                <span class="placeholder" style="display:none">🎸</span>`
            : `<span class="placeholder" style="display:flex">🎸</span>`;
        return `<div class="song-card group" ${entryAttrs} data-artist="${_escAttr(artist || '')}" ${interactiveAttrs}>
            <div class="card-art">
                ${artHtml}
                ${fmtBadge}
            </div>
            <div class="p-4">
                <div class="flex items-start justify-between gap-1">
                    <div class="min-w-0">
                        <h3 class="text-sm font-semibold text-white truncate group-hover:text-accent-light transition">${esc(title)}</h3>
                        <p class="text-xs text-gray-500 truncate mt-0.5">${esc(artist)}</p>
                    </div>
                    <div class="flex gap-1">
                        ${actionButtons}
                    </div>
                </div>
                <div class="flex items-center flex-wrap gap-1.5 mt-3 text-xs">
                    ${(() => { const _nm = _getArrangementNamingMode(); return (song.arrangements || []).map(a => _arrangementBadgeHtml(a, _nm)).join(''); })()}
                    ${tuning ? `<span class="px-1.5 py-0.5 rounded ${tuning === 'E Standard' ? 'bg-green-900/30 text-green-400' : 'bg-yellow-900/30 text-yellow-400'}">${esc(tuning)}</span>` : ''}
                    ${song.has_lyrics ? `<span class="px-1.5 py-0.5 bg-purple-900/30 rounded text-purple-300">Lyrics</span>` : ''}
                    ${duration ? `<span class="text-gray-600">${duration}</span>` : ''}
                </div>
                ${retuneBtn}
                ${syncStatus}
            </div>
        </div>`;
    }).join('');
    if (mode === 'append') {
        grid.insertAdjacentHTML('beforeend', html);
    } else {
        grid.innerHTML = html;
    }
    // Items list invalidation: any DOM mutation to the grid changes
    // the result of the next `_libNavItems` call.
    _bumpLibNavGeneration();
    // Re-apply the persistent selection after a fresh render so the
    // user's last picked card stays highlighted across reloads / a
    // round-trip through the player. Skip this during `append` mode
    // (infinite scroll) so restoring selection can't re-center the
    // viewport and yank the user away from the newly loaded page.
    // When a search input is focused the user is actively filtering —
    // re-apply the highlight but don't move the viewport (they didn't
    // leave the page and their scroll position should be preserved).
    if (mode !== 'append') {
        const screen = containerId.startsWith('fav') ? 'favorites' : 'home';
        // Scroll only on the first render after a screen entry —
        // routine search / sort / filter renders re-apply the
        // highlight without moving the viewport. The flag is
        // one-shot and consumed here.
        const scroll = _libScrollOnNextRender[screen];
        if (scroll) _libScrollOnNextRender[screen] = false;
        _restoreLibSelection(grid, screen, { scroll });
    }
}

// ── Tree View (server-side) ─────────────────────────────────────────────

async function loadTreeView() {
    const myEpoch = _libEpoch;
    if (!_treeStats) {
        _setLibraryLoadingMessage('lib-tree', 'lib-count', _libraryLoadingText());
        const q = document.getElementById('lib-filter').value.trim();
        const format = (document.getElementById('lib-format') || {}).value || '';
        const sp = new URLSearchParams();
        if (q) sp.set('q', q);
        if (format) sp.set('format', format);
        _applyLibraryProviderToParams(sp);
        _applyLibFiltersToParams(sp);
        const qs = sp.toString();
        try {
            _treeStats = await _fetchJsonOrThrow(`/api/library/stats${qs ? '?' + qs : ''}`);
        } catch (error) {
            if (myEpoch !== _libEpoch) return;
            _treeStats = null;
            _setLibraryOfflineMessage('lib-tree', 'lib-count', error.message || 'This source appears to be offline.');
            return;
        }
        if (myEpoch !== _libEpoch) return;
    }
    const q = document.getElementById('lib-filter').value.trim();
    await renderTreeInto('lib-tree', 'lib-count', _treeStats, _treeLetter, q, false, undefined, myEpoch);
}

let _treePage = 0;
const TREE_PAGE_SIZE = 50;

async function renderTreeInto(containerId, countId, stats, letter, q, favoritesOnly, page, expectedEpoch = _libEpoch) {
    if (page === undefined) page = favoritesOnly ? _favTreePage || 0 : _treePage;
    const container = document.getElementById(containerId);
    const screenProviderId = favoritesOnly ? 'local' : _activeLibraryProviderId();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');
    const chevron = `<svg class="chevron w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>`;

    const letterFn = favoritesOnly ? 'filterFavTreeLetter' : 'filterTreeLetter';
    const pageFn = favoritesOnly ? 'goFavTreePage' : 'goTreePage';
    let html = '<div class="flex flex-wrap gap-1 mb-6">';
    html += `<button onclick="${letterFn}('')" class="px-2 py-1 rounded text-xs transition ${
        !letter ? 'bg-accent text-white' : 'bg-dark-700 text-gray-400 hover:text-white'
    }">All</button>`;
    for (const l of letters) {
        const count = stats.letters[l] || 0;
        const active = letter === l;
        html += `<button onclick="${letterFn}('${l}')" class="px-2 py-1 rounded text-xs transition ${
            active ? 'bg-accent text-white' :
            count ? 'bg-dark-700 text-gray-300 hover:text-white' :
            'bg-dark-700/50 text-gray-700 cursor-default'
        }" ${count ? '' : 'disabled'}>${l}</button>`;
    }
    html += '</div>';

    // Fetch artists for the selected letter/all
    const params = new URLSearchParams();
    if (letter) params.set('letter', letter);
    if (q) params.set('q', q);
    if (favoritesOnly) params.set('favorites', '1');
    else _applyLibraryProviderToParams(params);
    const format = (document.getElementById('lib-format') || {}).value || '';
    if (format) params.set('format', format);
    if (!favoritesOnly) _applyLibFiltersToParams(params);
    params.set('page', page);
    params.set('size', TREE_PAGE_SIZE);
    let data;
    try {
        data = await _fetchJsonOrThrow(`/api/library/artists?${params}`);
    } catch (error) {
        if (expectedEpoch !== _libEpoch) return;
        _setLibraryOfflineMessage(containerId, countId, error.message || 'This source appears to be offline.');
        return;
    }
    if (expectedEpoch !== _libEpoch) return;
    const artists = data.artists || [];
    const totalArtists = data.total_artists || 0;
    const totalPages = Math.ceil(totalArtists / TREE_PAGE_SIZE);

    let songCount = 0, artistCount = artists.length;
    for (const a of artists) songCount += a.song_count;
    const pageInfo = totalPages > 1 ? ` · Page ${page + 1} of ${totalPages}` : '';
    document.getElementById(countId).textContent =
        `${totalArtists} artists (${songCount} songs on this page)${pageInfo}`;

    // A previous Expand/Collapse-All click is persisted as '1'/'0' and
    // overrides the auto-open heuristic for both artists and albums.
    // Library and Favorites have independent buttons and independent
    // keys (slopsmith.libTreeExpand vs slopsmith.favTreeExpand) — fed
    // off the favoritesOnly flag — so toggling one doesn't flip the
    // other's state. Falsy / unset key → fall back to the existing
    // heuristic (open when there's an active search or few rows).
    const expandKey = favoritesOnly ? _FAV_TREE_EXPAND_KEY : _LIB_TREE_EXPAND_KEY;
    const savedExpand = _readPersistedChoice(expandKey, _LIB_TREE_EXPAND_VALUES, null);
    const forceArtistOpen = savedExpand === '1';
    const forceArtistClosed = savedExpand === '0';

    for (const artist of artists) {
        const heuristicOpen = q || artists.length <= 5;
        const isOpen = forceArtistOpen ? true : forceArtistClosed ? false : heuristicOpen;
        const openClass = isOpen ? ' open' : '';
        const artistAria = _escAttr(`Toggle artist ${artist.name}`);
        html += `<div class="artist-row${openClass}">`;
        html += `<div class="artist-header" tabindex="0" role="button" aria-expanded="${isOpen ? 'true' : 'false'}" aria-label="${artistAria}" onclick="_onHeaderClick(this)">`;
        html += chevron;
        html += `<span class="text-white font-semibold text-sm flex-1">${esc(artist.name)}</span>`;
        html += `<span class="text-xs text-gray-600">${artist.song_count} song${artist.song_count !== 1 ? 's' : ''} · ${artist.album_count} album${artist.album_count !== 1 ? 's' : ''}</span>`;
        html += `</div><div class="artist-body">`;

        for (const album of artist.albums) {
            const albumSongs = Array.isArray(album.songs) ? album.songs : [];
            const artSong = albumSongs[0] || {};
            const artProviderId = _libraryProviderIdForSong(artSong, screenProviderId);
            const artUrl = _librarySongArtUrl(artSong, artProviderId);
            const albumHeuristicOpen = q || artist.albums.length === 1;
            const albumIsOpen = forceArtistOpen ? true : forceArtistClosed ? false : albumHeuristicOpen;
            const albumOpen = albumIsOpen ? ' open' : '';
            const albumAria = _escAttr(`Toggle album ${album.name}`);
            html += `<div class="album-group${albumOpen}">`;
            html += `<div class="album-header" tabindex="0" role="button" aria-expanded="${albumIsOpen ? 'true' : 'false'}" aria-label="${albumAria}" onclick="_onHeaderClick(this)">`;
            html += chevron;
            if (artUrl) html += `<img src="${_escAttr(artUrl)}" alt="" class="album-art-sm" loading="lazy" onerror="this.style.display='none'">`;
            html += `<span class="text-gray-300 text-sm flex-1">${esc(album.name)}</span>`;
            html += `<span class="text-xs text-gray-600">${albumSongs.length}</span>`;
            html += `</div><div class="album-body">`;

            for (const song of albumSongs) {
                const providerId = _libraryProviderIdForSong(song, screenProviderId);
                const localFilename = _libraryLocalFilename(song, providerId);
                const songId = _librarySongId(song);
                const title = _librarySongTitle(song, providerId);
                const duration = song.duration ? formatTime(song.duration) : '';
                const tuning = song.tuning || '';
                const isLocalProvider = _isLocalLibraryProvider(providerId);
                const isSloppak = song.format === 'sloppak';
                const stdRetune = isLocalProvider && localFilename && !isSloppak && tuning && !song.has_estd &&
                    ['Eb Standard', 'D Standard', 'C# Standard', 'C Standard'].includes(tuning);
                const canSyncRow = !localFilename && _providerSupports(providerId, 'song.sync');
                const isInteractiveRow = !!localFilename || canSyncRow;
                const providerAttr = `data-library-provider="${encodeURIComponent(providerId)}"`;
                // Keep data-library-song alongside data-play for provider-backed
                // entries once synced so _restoreLibSelection can still find the
                // card after a post-sync re-render.
                const rowSongAttr = !isLocalProvider ? ` data-library-song="${encodeURIComponent(songId)}"` : '';
                const rowAttrs = localFilename
                    ? `data-play="${encodeURIComponent(localFilename)}" ${providerAttr}${rowSongAttr}`
                    : `data-library-provider="${encodeURIComponent(providerId)}" data-library-song="${encodeURIComponent(songId)}"`;
                const ariaAction = localFilename ? 'Play' : 'Load and play';
                const rowAria = _escAttr(`${ariaAction} ${title}${artist.name ? ' by ' + artist.name : ''}`);
                const rowDisplayLabel = `${title}${artist.name ? ' by ' + artist.name : ''}`;
                const rowInteractiveAttrs = isInteractiveRow
                    ? `tabindex="0" role="button" aria-label="${rowAria}"`
                    : `role="listitem" aria-label="${_escAttr(rowDisplayLabel)}"`;
                html += `<div class="song-row" ${rowAttrs} data-artist="${_escAttr(artist.name || '')}" ${rowInteractiveAttrs}>`;
                html += `<div class="flex-1 min-w-0 flex items-center gap-2"><span class="text-sm text-white truncate block">${esc(title)}</span>${formatBadgeInline(song.format, song.stem_count)}</div>`;
                html += `<div class="flex items-center gap-1.5 flex-shrink-0 text-xs">`;
                { const _nm = _getArrangementNamingMode();
                  for (const arrangement of (song.arrangements || []))
                      html += _arrangementBadgeHtml(arrangement, _nm); }
                if (tuning)
                    html += `<span class="px-1.5 py-0.5 rounded ${tuning === 'E Standard' ? 'bg-green-900/30 text-green-400' : 'bg-yellow-900/30 text-yellow-400'}">${esc(tuning)}</span>`;
                if (song.has_lyrics)
                    html += `<span class="px-1.5 py-0.5 bg-purple-900/30 rounded text-purple-300">Lyrics</span>`;
                if (duration)
                    html += `<span class="text-gray-600 w-10 text-right">${duration}</span>`;
                if (stdRetune)
                    html += `<button data-retune="${encodeURIComponent(localFilename)}" data-title="${encodeURIComponent(title)}" data-tuning="${_escAttr(tuning)}" data-target="E Standard"
                        class="retune-btn px-1.5 py-0.5 bg-gold/10 hover:bg-gold/20 border border-gold/20 rounded text-gold" title="Convert to E Standard">E</button>`;
                if (isLocalProvider && localFilename) {
                    html += editBtn(song);
                    html += heartBtn(localFilename, song.favorite);
                } else if (!localFilename) {
                    html += _librarySyncStatusMarkup(providerId, songId, 'inline');
                }
                html += `</div></div>`;
            }
            html += `</div></div>`;
        }
        html += `</div></div>`;
    }

    // Pagination
    if (totalPages > 1) {
        html += '<div class="flex items-center justify-center gap-2 py-6">';
        html += `<button onclick="${pageFn}(0)" class="px-3 py-1.5 rounded-lg text-xs ${page === 0 ? 'text-gray-600' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${page === 0 ? 'disabled' : ''}>« First</button>`;
        html += `<button onclick="${pageFn}(${page - 1})" class="px-3 py-1.5 rounded-lg text-xs ${page === 0 ? 'text-gray-600' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${page === 0 ? 'disabled' : ''}>‹ Prev</button>`;
        const start = Math.max(0, page - 2);
        const end = Math.min(totalPages, start + 5);
        for (let i = start; i < end; i++) {
            html += `<button onclick="${pageFn}(${i})" class="px-3 py-1.5 rounded-lg text-xs ${i === page ? 'bg-accent text-white' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}">${i + 1}</button>`;
        }
        html += `<button onclick="${pageFn}(${page + 1})" class="px-3 py-1.5 rounded-lg text-xs ${page >= totalPages - 1 ? 'text-gray-600' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${page >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>`;
        html += `<button onclick="${pageFn}(${totalPages - 1})" class="px-3 py-1.5 rounded-lg text-xs ${page >= totalPages - 1 ? 'text-gray-600' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${page >= totalPages - 1 ? 'disabled' : ''}>Last »</button>`;
        html += '</div>';
    }

    container.innerHTML = html;
    // Items list invalidation — see grid render counterpart.
    _bumpLibNavGeneration();
    // Re-apply the persisted selection. For the tree we also expand
    // every collapsed ancestor of the saved row so the highlight is
    // actually visible — see _restoreLibSelection. Scroll only on
    // the first render after a screen entry (one-shot flag set in
    // showScreen) so routine renders don't yank the viewport.
    const screen = favoritesOnly ? 'favorites' : 'home';
    const scroll = _libScrollOnNextRender[screen];
    if (scroll) _libScrollOnNextRender[screen] = false;
    _restoreLibSelection(container, screen, { scroll });
}

function goTreePage(p) {
    _treePage = Math.max(0, p);
    loadTreeView();
    document.getElementById('library-section').scrollIntoView({ behavior: 'smooth' });
}

function filterTreeLetter(letter) {
    _treeLetter = (_treeLetter === letter) ? '' : letter;
    _treePage = 0;
    _writePersistedLetter(_LIB_TREE_LETTER_KEY, _treeLetter);
    loadTreeView();
}

function _toggleAllInTree(containerId, expand, persistKey) {
    // Scope the open/close to the named tree's container so toggling
    // Library doesn't flip the (offscreen) Favorites DOM and vice
    // versa — they share `.artist-row` / `.album-group` classes.
    const container = document.getElementById(containerId);
    if (!container) return;
    container.querySelectorAll('.artist-row').forEach(el => el.classList.toggle('open', expand));
    container.querySelectorAll('.album-group').forEach(el => el.classList.toggle('open', expand));
    // Bulk open/close changes which song-rows pass the visibility
    // filter in `_libNavItems` — same reason `_toggleHeader` bumps
    // the generation. Without this, a stale cached items list from
    // before the toggle would let arrow nav step into now-hidden
    // rows.
    _bumpLibNavGeneration();
    // Persist the explicit choice so the next page reload (or letter
    // change, which re-runs renderTreeInto) honors it instead of
    // falling back to the auto-open heuristic. Stored as '1'/'0' so a
    // missing key reliably means "no explicit choice".
    _writePersistedChoice(persistKey, expand ? '1' : '0');
}

function toggleAllArtists(expand) {
    _toggleAllInTree('lib-tree', expand, _LIB_TREE_EXPAND_KEY);
}

function toggleAllFavoriteArtists(expand) {
    _toggleAllInTree('fav-tree', expand, _FAV_TREE_EXPAND_KEY);
}

function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}

// `esc()` escapes the HTML-content metacharacters (<, >, &) but not
// quotes — fine for text-node interpolation but unsafe when the
// result is used as an attribute value, where a literal `"` ends the
// attribute early. Use `_escAttr` for any `attr="${...}"` site.
function _escAttr(s) {
    return esc(s == null ? '' : String(s))
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Toggle an artist/album header's parent `.open` state and keep
// `aria-expanded` on the header itself in sync so screen readers
// announce the collapsed/expanded transition correctly. Used by
// both the inline onclick (mouse) and the keyboard handlers.
function _toggleHeader(headerEl) {
    if (!headerEl) return;
    const parent = headerEl.parentElement;
    if (!parent) return;
    parent.classList.toggle('open');
    headerEl.setAttribute('aria-expanded', parent.classList.contains('open') ? 'true' : 'false');
    // Toggling open/closed changes which song-rows pass the
    // visibility filter in `_libNavItems`, so the cached items list
    // is now stale.
    _bumpLibNavGeneration();
}

// Called by the inline onclick on artist- and album-headers so the
// mouse-click path also syncs the persistent `.selected` state —
// keeps arrow-nav resuming from the last-clicked header rather than
// from a stale highlight on a different element.
function _onHeaderClick(el) {
    _toggleHeader(el);
    _setLibSelection(el, { focus: false });
}

// ── Favorites ────────────────────────────────────────────────────────────
let favView = 'grid';
let favPage = 0;
let _favTreeLetter = _readPersistedLetter(_FAV_TREE_LETTER_KEY);
let _favTreePage = 0;
let _favTreeStats = null;
let _favDebounce = null;

function heartBtn(filename, isFav) {
    return `<button data-fav="${encodeURIComponent(filename)}" class="fav-btn text-lg leading-none transition ${isFav ? 'text-red-500' : 'text-gray-600 hover:text-red-400'}" title="Toggle favorite">${isFav ? '&#9829;' : '&#9825;'}</button>`;
}

function editBtn(song) {
    return `<button data-edit='${JSON.stringify({f:song.filename,t:song.title||'',a:song.artist||'',al:song.album||'',y:song.year||''}).replace(/'/g,"&#39;")}' class="edit-btn text-gray-600 hover:text-accent-light transition" title="Edit metadata"><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg></button>`;
}

async function toggleFavorite(filename) {
    const resp = await fetch('/api/favorites/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
    });
    const data = await resp.json();
    // Refresh whichever view is active
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen?.id === 'favorites') loadFavorites();
    else loadLibrary();
    return data.favorite;
}

function setFavView(view) {
    favView = view;
    document.getElementById('fav-grid').classList.toggle('hidden', view !== 'grid');
    document.getElementById('fav-tree').classList.toggle('hidden', view !== 'tree');
    document.querySelectorAll('.fav-grid-ctrl').forEach(el => el.classList.toggle('hidden', view !== 'grid'));
    document.querySelectorAll('.fav-tree-ctrl').forEach(el => el.classList.toggle('hidden', view !== 'tree'));
    document.getElementById('fav-view-grid-btn').className = `px-3 py-2.5 text-sm transition ${view === 'grid' ? 'text-accent-light' : 'text-gray-600 hover:text-gray-400'}`;
    document.getElementById('fav-view-tree-btn').className = `px-3 py-2.5 text-sm transition ${view === 'tree' ? 'text-accent-light' : 'text-gray-600 hover:text-gray-400'}`;
    const pag = document.getElementById('fav-pagination');
    if (pag && view !== 'grid') pag.innerHTML = '';
    // Same reason as setLibView: dropping the items cache so the
    // next keypress re-derives against the now-active container.
    _bumpLibNavGeneration();
    loadFavorites();
}

async function loadFavorites() {
    if (favView === 'grid') await loadFavGridPage(favPage);
    else await loadFavTreeView();
}

function filterFavorites() {
    clearTimeout(_favDebounce);
    _favDebounce = setTimeout(() => { favPage = 0; _favTreeLetter = ''; loadFavorites(); }, 250);
}

function sortFavorites() { favPage = 0; loadFavorites(); }

async function loadFavGridPage(page = 0) {
    const q = document.getElementById('fav-filter').value.trim();
    const sort = document.getElementById('fav-sort').value;
    favPage = page;
    const params = new URLSearchParams({ q, page, size: PAGE_SIZE, sort, favorites: 1 });
    const resp = await fetch(`/api/library?${params}`);
    const data = await resp.json();
    const totalPages = Math.ceil((data.total || 0) / PAGE_SIZE);
    document.getElementById('fav-count').textContent =
        `${data.total || 0} favorites · Page ${favPage + 1} of ${Math.max(1, totalPages)}`;
    renderGridCards(data.songs || [], 'fav-grid');
    renderFavPagination(totalPages);
}

function renderFavPagination(totalPages) {
    let pag = document.getElementById('fav-pagination');
    if (!pag) {
        pag = document.createElement('div');
        pag.id = 'fav-pagination';
        pag.className = 'flex items-center justify-center gap-2 py-6';
        document.getElementById('fav-grid').after(pag);
    }
    if (totalPages <= 1) { pag.innerHTML = ''; return; }
    let html = '';
    html += `<button onclick="goFavPage(0)" class="px-3 py-1.5 rounded-lg text-xs ${favPage === 0 ? 'text-gray-600 cursor-default' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${favPage === 0 ? 'disabled' : ''}>« First</button>`;
    html += `<button onclick="goFavPage(${favPage - 1})" class="px-3 py-1.5 rounded-lg text-xs ${favPage === 0 ? 'text-gray-600 cursor-default' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${favPage === 0 ? 'disabled' : ''}>‹ Prev</button>`;
    const start = Math.max(0, favPage - 2);
    const end = Math.min(totalPages, start + 5);
    for (let i = start; i < end; i++) {
        html += `<button onclick="goFavPage(${i})" class="px-3 py-1.5 rounded-lg text-xs ${i === favPage ? 'bg-accent text-white' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}">${i + 1}</button>`;
    }
    html += `<button onclick="goFavPage(${favPage + 1})" class="px-3 py-1.5 rounded-lg text-xs ${favPage >= totalPages - 1 ? 'text-gray-600 cursor-default' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${favPage >= totalPages - 1 ? 'disabled' : ''}>Next ›</button>`;
    html += `<button onclick="goFavPage(${totalPages - 1})" class="px-3 py-1.5 rounded-lg text-xs ${favPage >= totalPages - 1 ? 'text-gray-600 cursor-default' : 'bg-dark-600 text-gray-300 hover:bg-dark-500'}" ${favPage >= totalPages - 1 ? 'disabled' : ''}>Last »</button>`;
    pag.innerHTML = html;
}

function goFavPage(p) { loadFavGridPage(Math.max(0, p)); }

async function loadFavTreeView() {
    if (!_favTreeStats) {
        const resp = await fetch('/api/library/stats?favorites=1');
        _favTreeStats = await resp.json();
    }
    const q = document.getElementById('fav-filter').value.trim();
    const letter = _favTreeLetter;
    // Reuse the tree renderer with fav-tree container and fav-count
    await renderTreeInto('fav-tree', 'fav-count', _favTreeStats, letter, q, true);
}

function filterFavTreeLetter(letter) {
    _favTreeLetter = (_favTreeLetter === letter) ? '' : letter;
    _favTreePage = 0;
    _writePersistedLetter(_FAV_TREE_LETTER_KEY, _favTreeLetter);
    loadFavTreeView();
}

function goFavTreePage(p) {
    _favTreePage = Math.max(0, p);
    loadFavTreeView();
}

// ── Settings ─────────────────────────────────────────────────────────────
let _defaultArrangement = '';

function _syncDefaultArrangementSelect(value) {
    const sel = document.getElementById('default-arrangement');
    if (!sel) return;
    const wanted = value || '';
    const existing = Array.from(sel.options).find(opt => opt.value === wanted);
    const dynamic = sel.querySelector('option[data-dynamic-default-arrangement]');
    if (dynamic && dynamic.value !== wanted) dynamic.remove();
    if (wanted && !existing) {
        const opt = document.createElement('option');
        opt.value = wanted;
        opt.textContent = `${wanted} (saved default)`;
        opt.dataset.dynamicDefaultArrangement = 'true';
        sel.appendChild(opt);
    }
    sel.value = wanted;
}

function _currentArrangementName() {
    const song = window.slopsmith?.currentSong;
    const sel = document.getElementById('arr-select');
    if (song?.arrangements && sel) {
        const match = song.arrangements.find(a => String(a.index) === String(sel.value));
        if (match?.name) return String(match.name);
    }
    if (song?.arrangement) return String(song.arrangement);
    const selectedText = sel?.selectedOptions?.[0]?.textContent || '';
    return selectedText.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function syncDefaultArrangementPin() {
    const btn = document.getElementById('arr-default-pin');
    if (!btn) return;
    const name = _currentArrangementName();
    const isDefault = !!name && name === _defaultArrangement;
    const label = name
        ? (isDefault ? `${name} is the default arrangement` : `Make ${name} the default for new songs`)
        : 'Select an arrangement to make it the default';
    btn.textContent = isDefault ? '★' : '☆';
    btn.setAttribute('aria-pressed', isDefault ? 'true' : 'false');
    btn.setAttribute('aria-label', label);
    btn.disabled = !name;
    btn.classList.toggle('text-yellow-300', isDefault);
    btn.classList.toggle('text-gray-400', !isDefault);
    btn.title = label;
}

async function pinCurrentArrangementDefault() {
    const name = _currentArrangementName();
    if (!name || name === _defaultArrangement) {
        syncDefaultArrangementPin();
        return;
    }
    const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ default_arrangement: name }),
    });
    if (!resp.ok) return;
    _defaultArrangement = name;
    _syncDefaultArrangementSelect(name);
    syncDefaultArrangementPin();
}

async function loadSettings() {
    // App Updates UI does not depend on /api/settings — run it first so a
    // failed fetch below still leaves the desktop updater wired up.
    // setupAppUpdates() is idempotent via _appUpdatesWired.
    setupAppUpdates();
    const resp = await fetch('/api/settings');
    const data = await resp.json();
    document.getElementById('dlc-path').value = data.dlc_dir || '';
    _defaultArrangement = data.default_arrangement || '';
    _syncDefaultArrangementSelect(_defaultArrangement);
    document.getElementById('demucs-server-url').value = data.demucs_server_url || '';
    const leftyEl = document.getElementById('setting-lefty');
    if (leftyEl) leftyEl.checked = highway.getLefty();
    // Restore master-difficulty slider from persisted value (defaults
    // to 100 when the key is absent — no behaviour change for users
    // who've never touched the slider).
    const masteryPct = typeof data.master_difficulty === 'number'
        ? Math.max(0, Math.min(100, data.master_difficulty))
        : 100;
    const masterySlider = document.getElementById('mastery-slider');
    const masteryLabel = document.getElementById('mastery-label');
    if (masterySlider) {
        masterySlider.value = masteryPct;
        handleSliderInput(masterySlider);
    }
    if (masteryLabel) masteryLabel.textContent = masteryPct + '%';
    highway.setMastery(masteryPct / 100);
    // Route the loaded value through setAvOffsetMs so the highway's
    // render clock, the Settings slider, the HUD readout, and the
    // module variable all pick it up consistently. Pass skipPersist
    // so we don't echo the loaded value back to the server.
    setAvOffsetMs(Number(data.av_offset_ms) || 0, /* skipPersist */ true);
    const psarcPlatformEl = document.getElementById('psarc-platform');
    if (psarcPlatformEl) psarcPlatformEl.value = data.psarc_platform || 'both';
    // Arrangement naming mode is localStorage-only (client preference).
    const namingModeEl = document.getElementById('arrangement-naming-mode');
    if (namingModeEl) namingModeEl.value = _getArrangementNamingMode();
    // Native folder picker — only present when running inside slopsmith-desktop.
    if (window.slopsmithDesktop && typeof window.slopsmithDesktop.pickDirectory === 'function') {
        document.getElementById('btn-pick-dlc')?.classList.remove('hidden');
    }
    syncDefaultArrangementPin();
}

// ── App Updates (desktop-only) ───────────────────────────────────────────
// Velopack auto-update controls, rendered as the first block of the Settings
// page. Whole block stays hidden in the plain web app; unhide + wire only
// when the slopsmith-desktop bridge (window.slopsmithDesktop.update) is
// present. On Linux the block renders but its controls are disabled — the
// desktop reports platform === 'linux' and short-circuits the IPC.

const APP_UPDATE_CHANNELS = ['stable', 'rc', 'beta', 'alpha'];
let _appUpdatesWired = false;

function setupAppUpdates() {
    const block = document.getElementById('app-updates-block');
    if (!block) return;
    const updateApi = window.slopsmithDesktop?.update;
    // Per-method capability check: an older or partial slopsmith-desktop
    // bridge may expose `update` without the full shape. Skip wiring (and
    // leave the block hidden) rather than throwing on first interaction.
    if (!updateApi
        || typeof updateApi.getStatus !== 'function'
        || typeof updateApi.setChannel !== 'function'
        || typeof updateApi.checkNow !== 'function') {
        return;
    }

    block.classList.remove('hidden');

    const channelSelect = document.getElementById('app-update-channel');
    const checkBtn = document.getElementById('app-update-check-now');
    const statusEl = document.getElementById('app-update-status');
    const linuxNote = document.getElementById('app-update-linux-note');
    if (!channelSelect || !checkBtn || !statusEl) return;

    // localStorage access can throw in storage-restricted contexts (sandbox
    // iframes, privacy modes, etc.); fall back to the default channel so the
    // panel still renders rather than aborting wiring entirely.
    let storedRaw = null;
    try { storedRaw = localStorage.getItem('slopsmith-update-channel'); } catch (_) { /* fall through */ }
    const stored = APP_UPDATE_CHANNELS.includes(storedRaw) ? storedRaw : 'stable';
    channelSelect.value = stored;

    const isLinux = window.slopsmithDesktop?.platform === 'linux';

    function showLinuxFallback(message) {
        if (linuxNote) linuxNote.classList.remove('hidden');
        channelSelect.disabled = true;
        checkBtn.disabled = true;
        statusEl.textContent = message || 'Auto-update is not available on this platform.';
    }

    function fmtTimestamp(ts) {
        if (!ts) return 'never';
        try {
            const d = new Date(ts);
            return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
        } catch (_) { return 'never'; }
    }

    function renderStatus(extra) {
        try {
            // Wrap in Promise.resolve so a future getStatus() that returns
            // synchronously won't blow up on .then().
            void Promise.resolve(updateApi.getStatus()).then((s) => {
                if (!s) { statusEl.textContent = extra || 'Updater status unavailable.'; return; }
                if (s.status === 'unsupported' || s.platform === 'linux') {
                    showLinuxFallback('Auto-update is not available on Linux.');
                    return;
                }
                if (s.status === 'error') {
                    const errMsg = s.message ? `Update error: ${s.message}` : 'Update check failed.';
                    statusEl.textContent = extra ? `${extra} · ${errMsg}` : errMsg;
                    return;
                }
                const parts = [
                    `Version ${s.currentVersion || '?'}`,
                    `channel ${s.channel || channelSelect.value}`,
                    `last checked ${fmtTimestamp(s.lastChecked)}`,
                ];
                statusEl.textContent = extra ? `${extra} · ${parts.join(' · ')}` : parts.join(' · ');
            }).catch((e) => {
                console.warn('[updater] getStatus failed:', e);
                statusEl.textContent = extra || 'Failed to read updater status.';
            });
        } catch (e) {
            console.warn('[updater] getStatus threw:', e);
            statusEl.textContent = extra || 'Failed to read updater status.';
        }
    }

    if (isLinux) {
        showLinuxFallback('Auto-update is not available on Linux.');
        // Keep main informed of the persisted channel even on Linux so
        // cross-platform reasoning about the channel stays consistent.
        // setChannel() may return a Promise — chain .catch() so a rejected
        // promise doesn't surface as an unhandled rejection.
        try {
            void Promise.resolve(updateApi.setChannel(stored)).catch((e) => {
                console.warn('[updater] setChannel(linux) failed:', e);
            });
        } catch (e) {
            console.warn('[updater] setChannel(linux) threw:', e);
        }
        return;
    }

    // Inform main of the persisted channel on each load. setChannel() on
    // main is idempotent when the channel already matches.
    try {
        void Promise.resolve(updateApi.setChannel(stored)).catch((e) => {
            console.warn('[updater] setChannel(initial) failed:', e);
        });
    } catch (e) {
        console.warn('[updater] setChannel(initial) threw:', e);
    }

    if (!_appUpdatesWired) {
        // Wire DOM listeners once. The elements live in static index.html
        // and are not recreated, so re-wiring on every loadSettings() call
        // would just stack duplicate handlers.
        channelSelect.addEventListener('change', async () => {
            const val = channelSelect.value;
            if (!APP_UPDATE_CHANNELS.includes(val)) return;
            try { localStorage.setItem('slopsmith-update-channel', val); } catch (_) {}
            try {
                // Await setChannel so the status line reflects what actually
                // happened — rendering "Channel set" unconditionally would
                // mislead users when the IPC rejects.
                await Promise.resolve(updateApi.setChannel(val));
                renderStatus(`Channel set to ${val}.`);
            } catch (e) {
                console.warn('[updater] setChannel failed:', e);
                renderStatus(`Failed to set channel to ${val}: ${e?.message || e}`);
            }
        });

        checkBtn.addEventListener('click', async () => {
            checkBtn.disabled = true;
            statusEl.textContent = 'Checking for updates…';
            let reEnableBtn = true;
            try {
                const result = await updateApi.checkNow();
                const status = result?.status || 'unknown';
                let msg;
                switch (status) {
                    case 'idle':
                        msg = "You're on the newest version in this channel.";
                        break;
                    case 'downloading':
                        msg = 'Update available — downloading…';
                        break;
                    case 'downloaded':
                        msg = 'Update downloaded — restart to apply.';
                        break;
                    case 'unsupported':
                        reEnableBtn = false;
                        showLinuxFallback('Auto-update is not available on Linux.');
                        return;
                    case 'error':
                        msg = `Update check failed${result?.message ? `: ${result.message}` : '.'}`;
                        break;
                    default:
                        msg = `Update check returned: ${status}`;
                }
                renderStatus(msg);
            } catch (e) {
                console.warn('[updater] checkNow failed:', e);
                statusEl.textContent = `Update check failed: ${e?.message || e}`;
            } finally {
                if (reEnableBtn) checkBtn.disabled = false;
            }
        });

        _appUpdatesWired = true;
    }

    renderStatus();
}

// ── Restart banner (desktop-only) ────────────────────────────────────────
// Subscribes to window.slopsmithDesktop.update.onDownloaded and renders a
// persistent banner with a "Restart now" button. Runs once at app boot so a
// download finishing while the user is on a non-Settings screen still pops
// the banner.

function initAppUpdateBanner() {
    const updateApi = window.slopsmithDesktop?.update;
    // Same capability gate as setupAppUpdates — the banner needs onDownloaded
    // to subscribe, getStatus to detect pre-existing pending updates on boot,
    // and apply to actually restart from the button. A bridge missing any
    // of these would partially fail; better to no-op cleanly.
    if (!updateApi
        || typeof updateApi.onDownloaded !== 'function'
        || typeof updateApi.getStatus !== 'function'
        || typeof updateApi.apply !== 'function') {
        return;
    }

    const BANNER_ID = 'slopsmith-update-banner';

    function renderUpdateBanner(payload) {
        // Avoid stacking duplicate banners if onDownloaded fires more than once.
        if (document.getElementById(BANNER_ID)) return;

        const banner = document.createElement('div');
        banner.id = BANNER_ID;
        banner.setAttribute('role', 'status');
        banner.style.cssText = [
            'position:fixed', 'top:0', 'left:0', 'right:0',
            'z-index:99999', 'padding:10px 16px',
            'background:linear-gradient(90deg,#1e3a8a,#4338ca)',
            'color:#fff', 'font-size:13px',
            'font-family:system-ui,sans-serif',
            'display:flex', 'align-items:center', 'justify-content:space-between',
            'gap:12px', 'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
        ].join(';');

        const text = document.createElement('span');
        const version = payload && payload.version ? ` (${payload.version})` : '';
        text.textContent = `Update downloaded${version} — restart to apply.`;

        const actions = document.createElement('span');
        actions.style.cssText = 'display:flex;gap:8px;align-items:center';

        const restartBtn = document.createElement('button');
        restartBtn.textContent = 'Restart now';
        restartBtn.style.cssText = [
            'padding:4px 12px', 'border-radius:4px',
            'background:#fff', 'color:#1e3a8a', 'border:none',
            'font-weight:600', 'cursor:pointer', 'font-size:13px',
        ].join(';');
        restartBtn.addEventListener('click', async () => {
            restartBtn.disabled = true;
            restartBtn.textContent = 'Restarting…';
            try {
                // apply() can resolve with { status: 'error' } instead of
                // throwing; only re-enable the button on that path.
                const result = await updateApi.apply();
                if (result?.status === 'error') {
                    console.warn('[updater] apply returned error:', result.message || 'unknown');
                    restartBtn.disabled = false;
                    restartBtn.textContent = 'Restart now';
                }
            } catch (e) {
                console.warn('[updater] apply failed:', e);
                restartBtn.disabled = false;
                restartBtn.textContent = 'Restart now';
            }
        });

        const dismissBtn = document.createElement('button');
        dismissBtn.textContent = 'Later';
        dismissBtn.setAttribute('aria-label', 'Dismiss update banner');
        dismissBtn.style.cssText = [
            'padding:4px 10px', 'border-radius:4px',
            'background:transparent', 'color:#fff',
            'border:1px solid rgba(255,255,255,0.3)',
            'cursor:pointer', 'font-size:13px',
        ].join(';');
        dismissBtn.addEventListener('click', () => banner.remove());

        actions.appendChild(restartBtn);
        actions.appendChild(dismissBtn);
        banner.appendChild(text);
        banner.appendChild(actions);

        const insert = () => {
            if (document.body) document.body.appendChild(banner);
            else document.addEventListener('DOMContentLoaded', () => document.body.appendChild(banner), { once: true });
        };
        insert();
    }

    try {
        updateApi.onDownloaded((payload) => {
            try { renderUpdateBanner(payload); }
            catch (e) { console.warn('[updater] renderUpdateBanner failed:', e); }
        });
    } catch (e) {
        console.warn('[updater] onDownloaded subscribe failed:', e);
    }

    // Catch pre-existing pending updates (downloaded in a previous session,
    // or restored on launch). onDownloaded only fires for downloads that
    // complete in the current session, so do an explicit status check too.
    try {
        void Promise.resolve(updateApi.getStatus()).then((status) => {
            // Render the banner for any 'downloaded' status; the version
            // string is best-effort — renderUpdateBanner() already drops the
            // "(vX.Y.Z)" suffix when none is supplied, so an update reported
            // without pending.version still surfaces the restart prompt.
            if (status && status.status === 'downloaded') {
                renderUpdateBanner({ version: status.pending?.version, channel: status.channel });
            }
        }).catch((e) => {
            console.warn('[updater] getStatus on init failed:', e);
        });
    } catch (e) {
        console.warn('[updater] getStatus on init threw:', e);
    }
}

// Updates the fill on slider elements. Expects a CSS variable --range-pct used
// in the track fill styling. Declared as a function (not a const) so it is
// hoisted onto window — audio-mixer.js calls it as window.handleSliderInput,
// matching the window.playSong / window.showScreen cross-script convention.
function handleSliderInput(el) {
    if (!el) return;
    const min = el.min || 0;
    const max = el.max || 100;
    const pct = (el.value - min) / (max - min) * 100;
    el.style.setProperty('--range-pct', pct + '%');
}

// A/V sync calibration. Positive = audio runs ahead of visuals; we
// add this to audio.currentTime when driving the highway so the
// visuals catch up. Persisted via /api/settings as av_offset_ms.
// Live-tunable from the player screen via [ / ] keys (Shift for
// ±50 ms) and from the Settings slider; both auto-save with the
// same debounced POST. loadSettings() seeds the value via
// setAvOffsetMs without saving (skipPersist=true) to avoid an
// echo-back round-trip.
let _avOffsetMs = 0;
let _avSaveDebounce = null;
function setAvOffsetMs(ms, skipPersist) {
    // Clamp to the same bounds the Settings/player-bar sliders enforce
    // (-1000..1000 ms). Defends against bad values from /api/settings
    // landing as `value` on <input type=range>.
    const n = Number(ms);
    _avOffsetMs = Math.max(-1000, Math.min(1000, Number.isFinite(n) ? n : 0));
    // Drive the highway's render-time shift. getTime() still returns
    // the audio-aligned chart time so plugins (note detection, etc.)
    // keep scoring against the real chart clock regardless of visual
    // calibration.
    if (typeof highway !== 'undefined' && highway?.setAvOffset) highway.setAvOffset(_avOffsetMs);
    // Sync any visible Settings slider
    const avSlider = document.getElementById('setting-av-offset');
    if (avSlider) {
        avSlider.value = _avOffsetMs;
        handleSliderInput(avSlider);
    }
    const avVal = document.getElementById('setting-av-offset-val');
    if (avVal) avVal.textContent = Math.round(_avOffsetMs);
    // Sync the inline player-bar slider (live-tunable while playing)
    const playerAvSlider = document.getElementById('player-av-offset-slider');
    if (playerAvSlider) {
        playerAvSlider.value = _avOffsetMs;
        handleSliderInput(playerAvSlider);
    }
    const playerAvLabel = document.getElementById('player-av-offset-label');
    if (playerAvLabel) {
        const rounded = Math.round(_avOffsetMs);
        playerAvLabel.textContent = `${rounded >= 0 ? '+' : ''}${rounded}ms`;
    }
    // Update the player HUD readout (hidden when offset = 0 to
    // avoid clutter; the keyboard shortcut is documented in the
    // Settings help text so it stays discoverable).
    const hud = document.getElementById('hud-avoffset');
    if (hud) {
        hud.textContent = `A/V ${_avOffsetMs >= 0 ? '+' : ''}${Math.round(_avOffsetMs)} ms`;
        hud.classList.toggle('hidden', _avOffsetMs === 0);
    }
    if (!skipPersist) _persistAvOffset();
}
function _persistAvOffset() {
    // Debounced persist — POST only the one field; the server merges.
    if (_avSaveDebounce) clearTimeout(_avSaveDebounce);
    _avSaveDebounce = setTimeout(async () => {
        _avSaveDebounce = null;
        try {
            await fetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ av_offset_ms: _avOffsetMs }),
            });
        } catch (e) {
            console.warn('A/V offset save failed:', e);
        }
    }, 400);
}
function nudgeAvOffsetMs(delta) {
    setAvOffsetMs(Math.max(-1000, Math.min(1000, _avOffsetMs + delta)));
}

// Open a native OS folder picker via the Electron bridge (desktop only) and
// stash the chosen path into the DLC input. User still has to hit Save.
async function pickDlcFolder() {
    if (!window.slopsmithDesktop?.pickDirectory) return;
    const path = await window.slopsmithDesktop.pickDirectory();
    if (path) document.getElementById('dlc-path').value = path;
}

async function saveSettings() {
    const defaultArrangement = document.getElementById('default-arrangement').value;
    const resp = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            dlc_dir: document.getElementById('dlc-path').value.trim(),
            default_arrangement: defaultArrangement,
            demucs_server_url: document.getElementById('demucs-server-url').value.trim(),
            av_offset_ms: _avOffsetMs,
            psarc_platform: document.getElementById('psarc-platform')?.value || 'both',
        }),
    });
    const data = await resp.json();
    if (resp.ok) {
        _defaultArrangement = defaultArrangement;
        _syncDefaultArrangementSelect(_defaultArrangement);
        syncDefaultArrangementPin();
    }
    document.getElementById('settings-status').textContent = data.message || data.error;
}

document.getElementById('arr-select')?.addEventListener('change', syncDefaultArrangementPin);

// Persist a single settings field the instant a control changes (used by
// the Settings dropdowns). The /api/settings POST handler merges only the
// keys present in the body, so this one-field write won't clobber dlc_dir
// or any other setting. No debounce: a <select> change event fires once
// per selection, unlike the A/V / mastery sliders' per-pixel oninput.
//
// The Settings-dropdown autosaves run through one chain so their POSTs are
// sent one at a time, in the order the user made the changes — the last
// selection is always the last write, for both rapid changes to one
// dropdown and back-to-back changes across different dropdowns. The A/V
// and mastery slider autosaves POST directly (not through this chain);
// the server-side config.json lock is what keeps those from racing the
// dropdown writes (see save_settings() in server.py).
let _settingSaveChain = Promise.resolve();
function persistSetting(key, value) {
    const next = _settingSaveChain.then(() => _postSetting(key, value));
    // Swallow failures so one failed write doesn't poison the chain and
    // block every later save.
    _settingSaveChain = next.catch(() => {});
    return next;
}
async function _postSetting(key, value) {
    const status = document.getElementById('settings-status');
    try {
        const resp = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [key]: value }),
        });
        const data = await resp.json();
        if (status) status.textContent = data.message || data.error || '';
    } catch (e) {
        if (status) status.textContent = 'Save failed: ' + e.message;
    }
}

// ── Settings export / import (slopsmith#113) ─────────────────────────────────
//
// Bundles server config + every localStorage key + opted-in plugin server
// files into a single JSON file.
//
// Apply semantics — phased, NOT all-or-nothing across the two stores:
//   1. Server first (/api/settings/import). Phase-1 validation guards
//      the whole bundle; phase-2 disk commit is per-file but ordered
//      so a mid-apply failure surfaces a `partial` field. A server
//      failure short-circuits before any localStorage write, so the
//      browser side stays untouched on validation refusals.
//   2. localStorage second, only after the server returns ok. Applied
//      as a MERGE (no clear): bundled keys overwrite, locally-present
//      keys absent from the bundle are preserved (so a plugin
//      installed after the export keeps its first-run defaults).
//      A localStorage exception here (quota / private mode) is
//      surfaced verbatim — server state is already committed and we
//      don't pretend the import was clean.
//
// In short: the server side is atomic in phase 1 and surface-partial in
// phase 2; the localStorage side is best-effort merge after server
// success. Failures are reported, never silenced.

async function exportSettings() {
    const status = document.getElementById('backup-status');
    status.textContent = 'Exporting...';
    try {
        const resp = await fetch('/api/settings/export');
        if (!resp.ok) {
            status.textContent = `Export failed (HTTP ${resp.status})`;
            return;
        }
        const bundle = await resp.json();
        // Layer in the browser's localStorage. Use the standard Storage
        // iteration API (length + key(i)) rather than Object.keys —
        // Object.keys on a Storage instance is not deterministic across
        // browsers and can both miss entries and include non-entry
        // properties depending on the implementation. Keys are preserved
        // verbatim as strings; that's how localStorage stores them, and
        // round-trip fidelity matters more than re-typing values that
        // were never typed in the first place.
        const localStorageData = {};
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key === null) continue;
            const value = localStorage.getItem(key);
            if (value !== null) localStorageData[key] = value;
        }
        bundle.local_storage = localStorageData;

        // Trigger download via blob + temporary <a download>. We honor the
        // server's Content-Disposition filename when present, otherwise
        // fall back to a date-stamped default.
        let filename = 'slopsmith-settings.json';
        const disposition = resp.headers.get('Content-Disposition');
        if (disposition) {
            const match = /filename="([^"]+)"/.exec(disposition);
            if (match) filename = match[1];
        }
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        status.textContent = `Exported ${filename}`;
    } catch (e) {
        status.textContent = `Export failed: ${e.message}`;
    }
}

async function importSettings(file) {
    if (!file) return;
    const status = document.getElementById('backup-status');
    if (!confirm('Import will overwrite settings present in the bundle (server config, browser preferences, and opted-in plugin data) and reload the page. Settings not in the bundle (e.g. from plugins installed after the export) are preserved. Continue?')) {
        status.textContent = 'Import cancelled';
        return;
    }
    let bundle;
    try {
        bundle = JSON.parse(await file.text());
    } catch (e) {
        status.textContent = `Import failed: not valid JSON (${e.message})`;
        return;
    }

    status.textContent = 'Importing...';
    let resp, data;
    try {
        resp = await fetch('/api/settings/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bundle),
        });
        data = await resp.json();
    } catch (e) {
        status.textContent = `Import failed: ${e.message}`;
        return;
    }
    // Two failure shapes to surface: our own validation handler
    // returns `{ok: false, error: "..."}`, but if the body fails
    // FastAPI's request-level validation (e.g. top-level value is
    // an array, not an object), the response is the framework's
    // `{detail: ...}` shape with no `ok` key. `resp.ok` distinguishes
    // both from success without depending on which path produced
    // the failure.
    if (!resp.ok || data.ok === false) {
        let msg = data.error;
        if (!msg && data.detail) {
            msg = typeof data.detail === 'string'
                ? data.detail
                : JSON.stringify(data.detail);
        }
        status.textContent = `Import failed: ${msg || `HTTP ${resp.status}`}`;
        return;
    }

    // Server applied successfully. Now apply the localStorage portion as
    // a MERGE (not clear+restore): keys in the bundle overwrite, keys
    // present locally but absent from the bundle are preserved. This
    // matters when a plugin was installed *after* the export — wiping
    // its localStorage would erase first-run defaults the plugin set on
    // load, leaving it in a worse state than before the import. The
    // tradeoff is that orphan keys from removed plugins or renamed key
    // schemes also linger; cleaning those up is the user's job.
    const ls = bundle.local_storage;
    if (ls && typeof ls === 'object') {
        try {
            for (const [key, value] of Object.entries(ls)) {
                if (typeof value === 'string') localStorage.setItem(key, value);
            }
        } catch (e) {
            // Quota exceeded / private mode etc. Server side already
            // committed, so we surface the partial state rather than
            // pretending it succeeded.
            status.textContent = `Server applied, but localStorage write failed: ${e.message}`;
            return;
        }
    }

    const warnings = (data.warnings || []).join('; ');
    status.textContent = warnings ? `Imported with warnings: ${warnings}. Reloading...` : 'Imported. Reloading...';
    setTimeout(() => location.reload(), 800);
}

// ── Diagnostics export (slopsmith#166) ───────────────────────────────────
//
// Companion to Settings export but for troubleshooting bug reports.
// Bundle layout + schemas: docs/diagnostics-bundle-spec.md.
//
// Frontend's job is to:
//   1. Snapshot the browser-only state (console ring buffer, hardware
//      probe, localStorage, ua) via window.slopsmith.diagnostics.
//   2. POST it to /api/diagnostics/export with the user's include /
//      redact toggles.
//   3. Stream the returned zip to disk.

function _diagIncludeFromUI() {
    const v = (id) => document.getElementById(id)?.checked !== false;
    return {
        system: v('diag-incl-system'),
        hardware: v('diag-incl-hardware'),
        logs: v('diag-incl-logs'),
        console: v('diag-incl-console'),
        plugins: v('diag-incl-plugins'),
    };
}

function _diagRedactFromUI() {
    const el = document.getElementById('diag-redact');
    return el ? !!el.checked : true;
}

// Map raw file paths inside the bundle to plain-English labels +
// descriptions for the preview UI. Only paths that show up in
// previews need entries — unknown paths fall back to the path itself.
const _DIAG_FILE_LABELS = {
    'system/version.json':   { label: 'App version',    desc: 'Slopsmith version, Python, OS' },
    'system/env.json':       { label: 'Environment',    desc: 'Allowlisted env vars (LOG_LEVEL, etc.). No secrets.' },
    'system/hardware.json':  { label: 'Hardware (server-side)', desc: 'CPU, RAM, GPU. In Docker this reflects the container, not the host.' },
    'system/plugins.json':   { label: 'Plugins',        desc: 'Loaded plugins + git commit + orphan detection.' },
    'logs/server.log':       { label: 'Server log',     desc: 'Tail of LOG_FILE (last ~5 MB).' },
    'logs/server.log.meta.json': { label: 'Log metadata', desc: 'Log file path, size, rotation info.' },
    'client/console.json':   { label: 'Browser console', desc: 'console.log/warn/error transcript + window errors.' },
    'client/hardware.json':  { label: 'Hardware (browser)', desc: 'WebGL/WebGPU adapter, host OS via userAgent.' },
    'client/local_storage.json': { label: 'Browser storage', desc: 'localStorage contents (preferences).' },
    'client/ua.json':        { label: 'User agent',     desc: 'Browser, screen, page URL.' },
};

function _formatBytes(n) {
    if (!n || n < 1024) return (n || 0) + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

function _escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function _renderDiagPreview(data) {
    const m = data.manifest || {};
    const files = m.files || [];
    const groups = { system: [], logs: [], client: [], plugins: [], other: [] };
    for (const f of files) {
        const top = (f.path || '').split('/')[0];
        (groups[top] || groups.other).push(f);
    }
    const totalBytes = files.reduce((s, f) => s + (f.size || 0), 0);
    const include = _diagIncludeFromUI();
    const redact = _diagRedactFromUI();

    const sections = [];
    // Per-file `summary` (server-derived) → human one-liner.
    function _summaryLine(path, summary) {
        if (!summary || typeof summary !== 'object') return '';
        if (path === 'system/plugins.json') {
            const loaded = summary.loaded_count || 0;
            const orphans = summary.orphan_count || 0;
            const orphPart = orphans ? ` · <span class="text-amber-400">${orphans} orphan${orphans === 1 ? '' : 's'}</span>` : '';
            return `${loaded} plugin${loaded === 1 ? '' : 's'} loaded${orphPart}`;
        }
        if (path === 'client/console.json') {
            const total = summary.entry_count || 0;
            const lvl = summary.by_level || {};
            const parts = [];
            for (const k of ['error','warn','info','log','debug']) {
                if (lvl[k]) parts.push(`${lvl[k]} ${k}`);
            }
            return `${total} entries${parts.length ? ' (' + parts.join(', ') + ')' : ''}`;
        }
        if (path === 'system/hardware.json') {
            const bits = [];
            if (summary.cpu_brand) bits.push(summary.cpu_brand);
            if (summary.cores_logical) bits.push(`${summary.cores_logical} cores`);
            if (summary.gpu_count) bits.push(`${summary.gpu_count} GPU`);
            if (summary.runtime) bits.push(`runtime: ${summary.runtime}`);
            return bits.join(' · ');
        }
        if (path === 'client/hardware.json') {
            const bits = [];
            if (summary.runtime) bits.push(summary.runtime);
            if (summary.webgl_renderer) bits.push(summary.webgl_renderer);
            return bits.join(' · ');
        }
        if (path === 'client/local_storage.json') {
            return `${summary.key_count || 0} keys`;
        }
        if (path === 'system/version.json') {
            const bits = [];
            if (summary.slopsmith) bits.push(`slopsmith ${summary.slopsmith}`);
            if (summary.python) bits.push(`python ${summary.python}`);
            if (summary.os) bits.push(summary.os);
            return bits.join(' · ');
        }
        return '';
    }

    function pushSection(title, list, emptyHint) {
        if (!list.length) {
            if (emptyHint) {
                sections.push(`<div class="mb-3"><div class="text-gray-300 font-semibold mb-1">${_escapeHtml(title)}</div><div class="text-gray-500">${_escapeHtml(emptyHint)}</div></div>`);
            }
            return;
        }
        const rows = list.map(f => {
            const meta = _DIAG_FILE_LABELS[f.path] || { label: f.path, desc: '' };
            const summary = _summaryLine(f.path, f.summary);
            const summaryHtml = summary
                ? `<div class="text-accent-light text-[10px] mt-0.5">${summary}</div>`
                : '';
            return `<div class="flex justify-between gap-4 py-1 border-b border-dark-600 last:border-0">
                <div class="min-w-0">
                    <div class="text-gray-200">${_escapeHtml(meta.label)}</div>
                    <div class="text-gray-500 text-[10px]">${_escapeHtml(meta.desc)}</div>
                    ${summaryHtml}
                </div>
                <div class="text-gray-400 text-right whitespace-nowrap">${_escapeHtml(_formatBytes(f.size))}</div>
            </div>`;
        }).join('');
        sections.push(`<div class="mb-3"><div class="text-gray-300 font-semibold mb-1">${_escapeHtml(title)}</div>${rows}</div>`);
    }

    pushSection('System', groups.system, include.system ? '' : 'Skipped (toggle off)');
    pushSection('Server logs', groups.logs, include.logs
        ? 'No log file configured — set LOG_FILE env var to include server logs.'
        : 'Skipped (toggle off)');
    pushSection('Plugin diagnostics', groups.plugins, include.plugins
        ? 'No plugins have opted in to diagnostics.'
        : 'Skipped (toggle off)');

    // Client section preview is a server-side estimate only — actual
    // client/* payloads are added at Export time after the browser
    // snapshots. Show what WILL be added, not file sizes.
    const clientLines = [];
    if (include.console) clientLines.push({ label: 'Browser console', desc: 'console.log/warn/error transcript + window errors.' });
    if (include.hardware) clientLines.push({ label: 'Hardware (browser)', desc: 'WebGL/WebGPU adapter, host OS via userAgent.' });
    clientLines.push({ label: 'Browser storage', desc: 'localStorage contents (preferences).' });
    clientLines.push({ label: 'User agent', desc: 'Browser, screen, page URL.' });
    const clientHtml = clientLines.map(c => `<div class="flex justify-between gap-4 py-1 border-b border-dark-600 last:border-0">
        <div><div class="text-gray-200">${_escapeHtml(c.label)}</div><div class="text-gray-500 text-[10px]">${_escapeHtml(c.desc)}</div></div>
        <div class="text-gray-500 text-right whitespace-nowrap">added on export</div>
    </div>`).join('');
    sections.push(`<div class="mb-3"><div class="text-gray-300 font-semibold mb-1">Browser data</div>${clientHtml}</div>`);

    const notesHtml = (m.notes || []).length
        ? `<div class="mb-3 bg-dark-600 border border-amber-500/30 rounded-lg p-2">
              <div class="text-amber-400 text-[10px] font-semibold uppercase mb-1">Notes</div>
              ${(m.notes).map(n => `<div class="text-gray-300 text-[11px]">• ${_escapeHtml(n)}</div>`).join('')}
           </div>`
        : '';

    const privacyHtml = redact
        ? `<div class="text-emerald-400 text-[11px]">🔒 Redaction enabled — paths, song names, IPs, and secrets will be replaced with stable hash tokens.</div>`
        : `<div class="text-amber-400 text-[11px]">⚠ Redaction OFF — bundle will contain raw paths, song names, and IPs. Only share with people you trust.</div>`;

    return `
        <div class="text-[11px]">
            <div class="flex justify-between items-baseline mb-2">
                <div class="text-gray-200 font-semibold">${_escapeHtml(data.filename)}</div>
                <div class="text-gray-400">${_escapeHtml(_formatBytes(totalBytes))}<span class="text-gray-600"> server-side</span></div>
            </div>
            <div class="text-gray-500 text-[10px] mb-3">runtime: ${_escapeHtml(m.runtime || 'unknown')} · exported_at: ${_escapeHtml(m.exported_at || '')}</div>
            ${notesHtml}
            ${sections.join('')}
            ${privacyHtml}
        </div>`;
}

async function previewDiagnostics() {
    const status = document.getElementById('diag-status');
    const preview = document.getElementById('diag-preview');
    if (!status || !preview) return;
    status.textContent = 'Building preview…';
    preview.classList.add('hidden');
    const include = _diagIncludeFromUI();
    const params = new URLSearchParams({
        redact: String(_diagRedactFromUI()),
        system: String(include.system),
        hardware: String(include.hardware),
        logs: String(include.logs),
        console: String(include.console),
        plugins: String(include.plugins),
    });
    try {
        const resp = await fetch(`/api/diagnostics/preview?${params.toString()}`);
        if (!resp.ok) {
            status.textContent = `Preview failed (HTTP ${resp.status})`;
            return;
        }
        const data = await resp.json();
        preview.innerHTML = _renderDiagPreview(data);
        preview.classList.remove('hidden');
        status.textContent = 'Preview ready.';
    } catch (e) {
        status.textContent = `Preview failed: ${e.message}`;
    }
}

async function exportDiagnostics() {
    const status = document.getElementById('diag-status');
    if (!status) return;
    status.textContent = 'Building bundle…';
    const include = _diagIncludeFromUI();
    const redact = _diagRedactFromUI();

    const diag = window.slopsmith && window.slopsmith.diagnostics;
    const body = {
        redact,
        include,
        client_console: include.console && diag ? diag.snapshotConsole() : null,
        client_hardware: include.hardware && diag ? await diag.snapshotHardware() : null,
        client_ua: diag ? diag.snapshotUa() : null,
        local_storage: diag ? diag.snapshotLocalStorage() : null,
        client_contributions: diag ? diag.snapshotContributions() : null,
    };

    let resp;
    try {
        resp = await fetch('/api/diagnostics/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    } catch (e) {
        status.textContent = `Export failed: ${e.message}`;
        return;
    }
    if (!resp.ok) {
        status.textContent = `Export failed (HTTP ${resp.status})`;
        return;
    }
    let filename = 'slopsmith-diag.zip';
    const disp = resp.headers.get('Content-Disposition');
    if (disp) {
        const m = /filename="([^"]+)"/.exec(disp);
        if (m) filename = m[1];
    }
    try {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        status.textContent = `Exported ${filename}`;
    } catch (e) {
        status.textContent = `Export failed during download: ${e.message}`;
    }
}

async function uploadSongs(fileList) {
    if (!fileList || fileList.length === 0) return;
    const all = Array.from(fileList);
    // Optional UI element — only present when on the Settings screen.
    // The navbar entry triggers uploads from any screen, where these aren't.
    const status = document.getElementById('rescan-status');
    const setStatus = (s) => { if (status) status.textContent = s; };

    // Client-side extension filter so we don't waste a round-trip on
    // clearly-invalid picks. The server validates again.
    const failures = [];
    const files = [];
    for (const f of all) {
        const lower = f.name.toLowerCase();
        if (lower.endsWith('.psarc') || lower.endsWith('.sloppak')) {
            files.push(f);
        } else {
            failures.push(`${f.name}: only .psarc or .sloppak accepted`);
        }
    }
    if (files.length === 0) {
        if (failures.length) alert(failures.join('\n'));
        return;
    }

    // The backend caps batches at _MAX_UPLOAD_FILES (50). Chunk if needed so a
    // big drag-and-drop of an album folder still works end-to-end.
    const BATCH = 50;
    const chunks = [];
    for (let i = 0; i < files.length; i += BATCH) chunks.push(files.slice(i, i + BATCH));

    let uploaded = 0;

    const postChunk = async (chunk, overwrite) => {
        const form = new FormData();
        for (const f of chunk) form.append('file', f);
        const url = '/api/songs/upload' + (overwrite ? '?overwrite=1' : '');
        const resp = await fetch(url, { method: 'POST', body: form });
        if (!resp.ok) {
            let data = {};
            try { data = await resp.json(); } catch (_) {}
            // Whole-request rejection (DLC misconfig, payload too large, etc.).
            throw new Error(data.error || resp.statusText || `HTTP ${resp.status}`);
        }
        const body = await resp.json();
        return body.results || [];
    };

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const label = chunks.length > 1
            ? `Uploading batch ${i + 1}/${chunks.length} (${chunk.length} files)...`
            : `Uploading ${chunk.length} file${chunk.length === 1 ? '' : 's'}...`;
        setStatus(label);

        let results;
        try {
            results = await postChunk(chunk, false);
        } catch (e) {
            for (const f of chunk) failures.push(`${f.name}: ${e.message}`);
            continue;
        }

        // Index file objects by name so a follow-up overwrite request can
        // resend the same blobs. Names within a chunk are unique on disk
        // (DLC dir is flat for this purpose), but two distinct user picks
        // could share a name — Map.set keeps the last one, which matches
        // server-side last-write-wins semantics.
        const byName = new Map(chunk.map(f => [f.name, f]));

        const conflicts = [];
        for (const r of results) {
            if (r.status === 'ok') {
                uploaded++;
            } else if (r.status === 'exists') {
                conflicts.push(r);
            } else {
                failures.push(`${r.filename}: ${r.error || 'upload failed'}`);
            }
        }

        if (conflicts.length > 0) {
            const names = conflicts.map(c => c.filename);
            const preview = names.slice(0, 5).join(', ') + (names.length > 5 ? `, +${names.length - 5} more` : '');
            const ok = confirm(
                `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} already exist in your DLC folder:\n${preview}\n\nOverwrite?`
            );
            if (!ok) {
                for (const c of conflicts) failures.push(`${c.filename}: skipped (already exists)`);
                continue;
            }
            const retryFiles = conflicts
                .map(c => byName.get(c.filename))
                .filter(Boolean);
            setStatus(`Overwriting ${retryFiles.length} file${retryFiles.length === 1 ? '' : 's'}...`);
            let retryResults;
            try {
                retryResults = await postChunk(retryFiles, true);
            } catch (e) {
                for (const f of retryFiles) failures.push(`${f.name}: ${e.message}`);
                continue;
            }
            for (const r of retryResults) {
                if (r.status === 'ok') uploaded++;
                else failures.push(`${r.filename}: ${r.error || 'upload failed'}`);
            }
        }
    }

    if (failures.length === 0) {
        setStatus(`Uploaded ${uploaded} file${uploaded === 1 ? '' : 's'}. Scanning...`);
    } else {
        // Denominator is the full user selection (`all.length`), not just the
        // post-filter `files.length`. Otherwise picking one valid file plus
        // one `.txt` would show "Uploaded 1/1" with a failure listed below,
        // overstating the success rate.
        const total = all.length;
        const msg = `Uploaded ${uploaded}/${total}. ${failures.length} failed:\n` + failures.join('\n');
        alert(msg);
        setStatus(`Uploaded ${uploaded}/${total}, ${failures.length} failed.`);
    }
    if (uploaded > 0) {
        // Server kicked off a background scan after the batch finished; poll
        // for completion and refresh the library when it finishes.
        _pollScanAndRefresh(status);
    }
}

let _uploadScanPoller = null;

function _pollScanAndRefresh(statusEl) {
    const setStatus = (s) => { if (statusEl) statusEl.textContent = s; };
    if (_uploadScanPoller) _uploadScanPoller.stop();

    const MAX_FAILURES = 5;
    const INTERVAL_MS = 1000;
    let stopped = false;
    let timerId = null;
    let failures = 0;
    const stop = () => {
        stopped = true;
        if (timerId) { clearTimeout(timerId); timerId = null; }
        if (_uploadScanPoller && _uploadScanPoller.stop === stop) _uploadScanPoller = null;
    };
    _uploadScanPoller = { stop };

    const tick = async () => {
        timerId = null;
        try {
            const sr = await fetch('/api/scan-status');
            if (!sr.ok) throw new Error(`HTTP ${sr.status}`);
            const sd = await sr.json();
            if (stopped) return;
            failures = 0;
            if (sd.running) {
                const cur = sd.current ? ` · ${sd.current}` : '';
                setStatus(`${sd.done} / ${sd.total} scanned${cur}...`);
            } else {
                stop();
                if (sd.error) setStatus(`Error: ${sd.error}`);
                else setStatus('Done!');
                _treeStats = null;
                _tuningNames = null;
                // Mirror the delete path: refresh whichever collection is
                // currently visible. Overwriting a favorited song while
                // viewing Favorites otherwise leaves a stale entry.
                const activeScreen = document.querySelector('.screen.active');
                if (activeScreen?.id === 'favorites') loadFavorites();
                else loadLibrary();
                return;
            }
        } catch (e) {
            if (stopped) return;
            failures++;
            if (failures >= MAX_FAILURES) {
                stop();
                setStatus(`Scan status unavailable: ${e.message || e}`);
                return;
            }
        }
        if (!stopped) timerId = setTimeout(tick, INTERVAL_MS);
    };
    timerId = setTimeout(tick, INTERVAL_MS);
}

async function rescanLibrary() {
    const btn = document.getElementById('btn-rescan');
    const status = document.getElementById('rescan-status');
    btn.disabled = true;
    btn.textContent = 'Scanning...';
    status.textContent = '';
    const resp = await fetch('/api/rescan', { method: 'POST' });
    const data = await resp.json();
    status.textContent = data.message;
    // Poll until done
    const poll = setInterval(async () => {
        const sr = await fetch('/api/scan-status');
        const sd = await sr.json();
        if (sd.running) {
            const cur = sd.current ? ` · ${sd.current}` : '';
            status.textContent = `${sd.done} / ${sd.total} scanned${cur}...`;
        } else {
            clearInterval(poll);
            btn.disabled = false;
            btn.textContent = 'Rescan Library';
            status.textContent = sd.error ? `Error: ${sd.error}` : 'Done!';
            _treeStats = null;
            _tuningNames = null;  // re-fetch on next drawer open
            loadLibrary();
        }
    }, 1000);
}

async function fullRescanLibrary() {
    if (!confirm('This will clear the entire library cache and re-scan all songs. This can take a long time with large libraries. Continue?')) return;
    const btn = document.getElementById('btn-full-rescan');
    const status = document.getElementById('rescan-status');
    btn.disabled = true;
    btn.textContent = 'Clearing...';
    const resp = await fetch('/api/rescan/full', { method: 'POST' });
    const data = await resp.json();
    btn.textContent = 'Scanning...';
    status.textContent = data.message;
    const poll = setInterval(async () => {
        const sr = await fetch('/api/scan-status');
        const sd = await sr.json();
        if (sd.running) {
            const cur = sd.current ? ` · ${sd.current}` : '';
            status.textContent = `${sd.done} / ${sd.total} scanned${cur}...`;
        } else {
            clearInterval(poll);
            btn.disabled = false;
            btn.textContent = 'Full Rescan';
            status.textContent = sd.error ? `Error: ${sd.error}` : 'Done!';
            _treeStats = null;
            _tuningNames = null;  // re-fetch on next drawer open
            loadLibrary();
        }
    }, 1000);
}

// ── Plugin Updates ───────────────────────────────────────────────────────
async function checkPluginUpdates() {
    const btn = document.getElementById('btn-check-updates');
    const status = document.getElementById('updates-status');
    const list = document.getElementById('plugin-updates-list');
    btn.disabled = true;
    btn.textContent = 'Checking...';
    status.textContent = '';
    list.innerHTML = '';
    try {
        const resp = await fetch('/api/plugins/updates');
        const data = await resp.json();
        const updates = data.updates || {};
        const keys = Object.keys(updates);
        if (keys.length === 0) {
            status.textContent = 'All plugins are up to date.';
        } else {
            status.textContent = `${keys.length} update${keys.length > 1 ? 's' : ''} available`;
            for (const id of keys) {
                const u = updates[id];
                const row = document.createElement('div');
                row.className = 'flex items-center gap-3 bg-dark-700 rounded-lg px-4 py-2';
                row.innerHTML = `
                    <span class="text-sm text-gray-300 flex-1">${u.name} <span class="text-xs text-gray-500">(${u.behind} commit${u.behind > 1 ? 's' : ''} behind — ${u.local} → ${u.remote})</span></span>
                    <button onclick="updatePlugin('${id}', this)" class="bg-accent/20 hover:bg-accent/30 text-accent-light px-3 py-1 rounded-lg text-xs transition">Update</button>`;
                list.appendChild(row);
            }
        }
    } catch (e) {
        status.textContent = 'Failed to check for updates.';
    }
    btn.disabled = false;
    btn.textContent = 'Check for Updates';
}

async function updatePlugin(pluginId, btn) {
    btn.disabled = true;
    btn.textContent = 'Updating...';
    try {
        const resp = await fetch(`/api/plugins/${pluginId}/update`, { method: 'POST' });
        const data = await resp.json();
        if (data.ok) {
            btn.textContent = 'Updated — restart to apply';
            btn.className = 'bg-green-900/30 text-green-400 px-3 py-1 rounded-lg text-xs';
        } else {
            btn.textContent = 'Failed';
            btn.title = data.error || '';
        }
    } catch (e) {
        btn.textContent = 'Error';
    }
}

// ── Plugin functions loaded dynamically from plugin screen.js files ──────
// (searchCF, installCF, loginCF, searchUG, buildFromUG, etc.)

// ── Retune ───────────────────────────────────────────────────────────────
function retuneSong(filename, title, tuning, target) {
    target = target || 'E Standard';
    if (!confirm(`Convert "${title}" from ${tuning} to ${target}?`)) return;

    // Show modal overlay
    const modal = document.createElement('div');
    modal.id = 'retune-modal';
    modal.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
    modal.innerHTML = `
        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-8 w-full max-w-md mx-4 shadow-2xl">
            <h3 class="text-lg font-bold text-white mb-1">Converting to ${target}</h3>
            <p class="text-sm text-gray-400 mb-5">${title}</p>
            <div class="progress-bar mb-3"><div class="fill" id="retune-bar" style="width:0%"></div></div>
            <p class="text-xs text-gray-500" id="retune-stage">Connecting...</p>
        </div>`;
    document.body.appendChild(modal);

    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/retune?filename=${encodeURIComponent(decodeURIComponent(filename))}&target=${encodeURIComponent(target)}`);
    ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.progress !== undefined) {
            document.getElementById('retune-bar').style.width = msg.progress + '%';
        }
        if (msg.stage) {
            document.getElementById('retune-stage').textContent = msg.stage;
        }
        if (msg.done) {
            modal.querySelector('.bg-dark-700').innerHTML = `
                <div class="text-center">
                    <div class="text-3xl mb-3">✓</div>
                    <h3 class="text-lg font-bold text-white mb-1">Done!</h3>
                    <p class="text-sm text-gray-400 mb-5">${msg.filename}</p>
                    <button onclick="document.getElementById('retune-modal').remove();loadLibrary()"
                        class="bg-accent hover:bg-accent-light px-6 py-2 rounded-xl text-sm font-semibold text-white transition">OK</button>
                </div>`;
        }
        if (msg.error) {
            modal.querySelector('.bg-dark-700').innerHTML = `
                <div class="text-center">
                    <div class="text-3xl mb-3">✕</div>
                    <h3 class="text-lg font-bold text-red-400 mb-1">Failed</h3>
                    <p class="text-sm text-gray-400 mb-5">${msg.error}</p>
                    <button onclick="document.getElementById('retune-modal').remove()"
                        class="bg-dark-600 hover:bg-dark-500 px-6 py-2 rounded-xl text-sm text-gray-300 transition">Close</button>
                </div>`;
        }
    };
    ws.onerror = () => {
        modal.querySelector('.bg-dark-700').innerHTML = `
            <div class="text-center">
                <p class="text-red-400 mb-4">Connection lost</p>
                <button onclick="document.getElementById('retune-modal').remove()"
                    class="bg-dark-600 px-6 py-2 rounded-xl text-sm text-gray-300">Close</button>
            </div>`;
    };
}

// ── Player ───────────────────────────────────────────────────────────────
const audio = document.getElementById('audio');
let isPlaying = false;
let _lastSongPositionEventAt = 0;

function _emitSongPositionChanged(time, duration) {
    const now = Date.now();
    if (now - _lastSongPositionEventAt < 250) return;
    _lastSongPositionEventAt = now;
    const payload = (typeof _songEventPayload === 'function') ? _songEventPayload() : { time };
    window.slopsmith.emit('song:position-changed', Object.assign(payload, { duration }));
}

function _applyPreservePitch(el) {
    if (!el) return;
    if ('preservesPitch' in el) el.preservesPitch = true;
    if ('mozPreservesPitch' in el) el.mozPreservesPitch = true;
    if ('webkitPreservesPitch' in el) el.webkitPreservesPitch = true;
}
_applyPreservePitch(audio);

// In Slopsmith Desktop, WASAPI Exclusive Mode locks the audio device so Chromium
// cannot play through it. When window._juceMode is true, song audio is routed
// through the JUCE backing track player instead of the HTML5 <audio> element.
window._juceMode = false;
window._juceAudioUrl = null;
const jucePlayer = {
    _timer: null,
    _pos: 0,
    _dur: 0,
    _pollAt: 0,    // performance.now() when _pos was last set
    _polling: false,
    _speed: 1,
    get currentTime() {
        if (!this._polling) return this._pos;
        // Interpolate between IPC polls so highway motion is smooth at 60fps
        // Scale by _speed so at 0.7x the interpolated clock advances 0.7s/s
        const elapsed = (performance.now() - this._pollAt) / 1000;
        return Math.min(this._pos + elapsed * this._speed, this._dur > 0 ? this._dur : Infinity);
    },
    get duration() { return this._dur; },
    async play() {
        try {
            await window.slopsmithDesktop.audio.startBacking();
        } catch (err) {
            console.warn('[jucePlayer] startBacking failed:', err);
            return false;
        }
        this._startPolling();
        return true;
    },
    async pause() {
        // Snapshot the interpolated position before stopping the poll so
        // _pos stays at the visible pause point rather than jumping back
        // to the last raw IPC sample (which can be up to 100ms behind).
        this._pos = this.currentTime;
        this._pollAt = performance.now();
        this._stopPolling();
        try {
            await window.slopsmithDesktop.audio.stopBacking();
        } catch (err) {
            console.warn('[jucePlayer] stopBacking failed:', err);
        }
    },
    async seek(s) {
        const prev = this._pos;
        this._pos = s;
        this._pollAt = performance.now();
        try {
            await window.slopsmithDesktop.audio.seekBacking(s);
        } catch (err) {
            console.warn('[jucePlayer] seekBacking failed:', err);
            this._pos = prev;
            this._pollAt = performance.now();
        }
    },
    _startPolling() {
        this._stopPolling();
        this._polling = true;
        this._pollAt = performance.now();
        const self = this;
        function scheduleNext() {
            self._timer = setTimeout(async () => {
                if (!self._polling) return;
                try {
                    self._pos = await window.slopsmithDesktop.audio.getBackingPosition();
                    self._pollAt = performance.now();
                    _emitSongPositionChanged(self.currentTime, self.duration || null);
                } catch (err) {
                    console.warn('[jucePlayer] position poll failed:', err);
                } finally {
                    if (self._polling) scheduleNext();
                }
            }, 100);
        }
        scheduleNext();
    },
    _stopPolling() {
        this._polling = false;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    },
    setRate(rate) {
        this._pos = this.currentTime;
        this._pollAt = performance.now();
        this._speed = rate;
    },
    async stop() {
        await this.pause();
        this._pos = 0;
        this._dur = 0;
        this._pollAt = 0;
        this._speed = 1;
    },
};
window.jucePlayer = jucePlayer;

// ── Engine start/stop → re-route song audio (HTML5 ⇄ JUCE) ──────────────────
// window._juceMode is otherwise decided once, at song-load time (highway.js),
// from isAudioRunning(). If the JUCE audio engine is started or stopped *after*
// a song is already loaded (e.g. the user presses CHAIN / AMP), that decision
// goes stale: the song stays on the HTML5 <audio> element while the engine
// grabs the device in exclusive mode (audible guitar, silent song), or it stays
// on a dead JUCE backing transport. This watcher migrates the loaded song
// between the two paths whenever the engine's running state changes, preserving
// playback position and play/pause state.
(function _installJuceEngineRoutingWatcher() {
    const juceApi = window.slopsmithDesktop?.audio;
    if (!juceApi || typeof juceApi.isAudioRunning !== 'function') return;

    let _rerouteInFlight = false;
    // URL that JUCE's loadBackingTrack *explicitly rejected* (ok === false —
    // e.g. a codec it can't read). The poll below would otherwise retry the
    // same doomed track every 350 ms; remember it and skip until the song
    // changes. Only a hard JUCE reject is memoised here — transient failures
    // (a network blip on /api/audio-local-path, an isAudioRunning() race
    // during a device restart) are deliberately NOT memoised so they retry.
    let _rerouteRejectedUrl = null;
    // Returns true when window._currentSongAudio no longer references the exact
    // snapshot object captured at reroute entry — i.e. the song was swapped (or
    // cleared) mid-flight. Staleness is detected by object-reference identity,
    // not by URL value.
    function _isStale(songAudio) {
        return window._currentSongAudio !== songAudio;
    }

    // Migrates the loaded song from the HTML5 element onto the JUCE backing
    // transport. Throws only on transient/unexpected failures.
    // `songAudio` is the snapshot captured at reroute entry; if it stops being
    // the current song mid-flight we abort without mutating global routing.
    // Returns a distinct string outcome — the caller must NOT conflate them:
    //   'switched' — song now plays via JUCE.
    //   'rejected' — JUCE hard-rejected the track (codec). Caller memoises it.
    //   'stale'    — the loaded song changed mid-flight; aborted, NOT memoised.
    // (a transient transport-start failure throws instead — also not memoised.)
    async function _switchHtml5ToJuce(songAudio) {
        const url = songAudio.url;
        const wasPlaying = isPlaying;
        const pos = audio.currentTime || 0;
        window.slopsmith?.playback?.recordRouteChange?.({
            routeKind: 'desktop-native',
            state: 'switching',
            preservedTime: true,
            safeReason: 'desktop audio engine became active',
            requesterId: 'core.juce-route',
        });
        // Mark a reroute in progress so the <audio> 'play'/'pause' listeners
        // suppress their song:play / song:pause emissions: the migration is
        // transparent — playback genuinely continues — so plugin state and
        // window.slopsmith.isPlaying must NOT flip. This also silences the
        // "Audio paused unexpectedly" diagnostic. A REFCOUNT (not a boolean)
        // lets an overlapping reroute's deferred release coexist: each switch
        // increments on entry and decrements after its own timeout; listeners
        // treat any count > 0 as "reroute active".
        window._juceRerouteInProgress = (window._juceRerouteInProgress || 0) + 1;
        audio.pause();
        try {
            const res = await fetch(`/api/audio-local-path?url=${encodeURIComponent(url)}`);
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const { path } = await res.json();
            if (_isStale(songAudio)) return 'stale';   // song changed mid-fetch
            const ok = await juceApi.loadBackingTrack(path);
            if (ok === false) {
                // JUCE rejected the track — stay on HTML5, resume if needed.
                console.warn('[juce-reroute] loadBackingTrack rejected; staying on HTML5');
                // Only resume if the element still has a source. In the normal
                // flow audio.src is intact here, but a prior HTML5→JUCE switch
                // clears it — re-point + load before resuming so a bounced
                // reroute doesn't try to play() an empty element.
                if (isPlaying && !_isStale(songAudio)) {
                    if (!audio.src) { audio.src = url; audio.load(); }
                    try { await audio.play(); } catch (_) { /* ignore */ }
                }
                window.slopsmith?.playback?.recordRouteChange?.({
                    routeKind: 'browser-media',
                    state: 'degraded',
                    preservedTime: true,
                    safeReason: 'desktop audio route rejected track; kept browser media route',
                    requesterId: 'core.juce-route',
                });
                return 'rejected';
            }
            if (_isStale(songAudio)) return 'stale';
            const dur = await juceApi.getBackingDuration();
            await juceApi.seekBacking(pos);
            // Start the new transport BEFORE committing global routing state, so
            // a play() failure can't leave us in "JUCE mode, nothing playing"
            // (the silent-song state this watcher exists to prevent).
            // jucePlayer.play() RETURNS false (it does not throw) when
            // startBacking fails — check the result, don't just await it.
            // A play() failure is a TRANSIENT transport-start issue, not a hard
            // codec reject: throw (rather than returning 'rejected') so the
            // caller's catch path handles it WITHOUT memoising the URL, leaving
            // it free to retry on the next poll. Only 'rejected' is memoised.
            // Re-read isPlaying as late as possible: the user can press Pause
            // during the multi-await fetch/IPC chain above. Starting the JUCE
            // transport off a stale `wasPlaying` snapshot would resume a song
            // the user just paused. Only start it if playback is still wanted.
            if (isPlaying) {
                const started = await jucePlayer.play();
                if (started === false) {
                    if (!_isStale(songAudio) && isPlaying) {
                        try { await audio.play(); } catch (_) { /* ignore */ }
                    }
                    throw new Error('jucePlayer.play() failed (transient transport start)');
                }
            }
            if (_isStale(songAudio)) {
                // Song changed while JUCE was spinning up — undo and bail.
                await jucePlayer.pause().catch(() => {});
                return 'stale';
            }
            if (window.jucePlayer) {
                jucePlayer._dur = dur;
                jucePlayer._pos = pos;
                jucePlayer._pollAt = performance.now();
            }
            window._juceMode = true;
            window._juceAudioUrl = url;
            const _spSlider = document.getElementById?.('speed-slider');
            if (_spSlider) setSpeed(_spSlider.value / 100);
            audio.src = '';
            try {
                const apply = window.slopsmith?.audio?.applySongVolume;
                if (typeof apply === 'function') await apply();
            } catch (_) { /* best-effort */ }
            console.log('[juce-reroute] HTML5 → JUCE @', pos.toFixed(2), 's playing=', wasPlaying);
            window.slopsmith?.playback?.recordRouteChange?.({
                routeKind: 'desktop-native',
                state: 'active',
                preservedTime: true,
                safeReason: 'desktop audio route active',
                requesterId: 'core.juce-route',
            });
            return 'switched';
        } catch (err) {
            // Path lookup, JSON parse, or a JUCE IPC call threw partway through.
            // audio.pause() already ran above; restore HTML5 playback so a
            // previously playing song isn't left silently paused, then re-throw
            // so the caller logs it. The caller does NOT memoise this URL —
            // transient failures must retry on the next poll.
            if (isPlaying && !window._juceMode && !_isStale(songAudio)) {
                if (!audio.src) { audio.src = url; audio.load(); }
                try { await audio.play(); } catch (_) { /* ignore */ }
            }
            window.slopsmith?.playback?.recordRouteChange?.({
                routeKind: 'browser-media',
                state: 'degraded',
                preservedTime: true,
                safeReason: 'desktop audio route failed; kept browser media route',
                requesterId: 'core.juce-route',
            });
            throw err;
        } finally {
            // Clearing audio.src above dispatches a 'pause' event in a later
            // task, after this synchronous finally. Defer the refcount
            // decrement so that trailing event is still suppressed; a 0ms
            // timeout lands after the pending pause-event task. Decrementing
            // (rather than zeroing) leaves any overlapping reroute's own
            // suppression intact.
            setTimeout(() => {
                window._juceRerouteInProgress = Math.max(
                    0, (window._juceRerouteInProgress || 1) - 1);
            }, 0);
        }
    }

    async function _switchJuceToHtml5(songAudio) {
        const url = songAudio.url;
        const wasPlaying = isPlaying;
        const pos = (window.jucePlayer ? jucePlayer.currentTime : 0) || 0;
        window.slopsmith?.playback?.recordRouteChange?.({
            routeKind: 'browser-media',
            state: 'switching',
            preservedTime: true,
            safeReason: 'desktop audio engine stopped',
            requesterId: 'core.juce-route',
        });
        // Mark a reroute in progress (refcount) so the <audio> 'play' listener
        // suppresses its song:play emission — the migration is transparent and
        // playback genuinely continues, so plugin state must not flip. Held
        // until after the (possibly deferred) audio.play() event has fired.
        window._juceRerouteInProgress = (window._juceRerouteInProgress || 0) + 1;
        let _suppressionReleased = false;
        const _releaseSuppression = () => {
            if (_suppressionReleased) return;
            _suppressionReleased = true;
            // Defer so the 'play' (or 'pause') event task fires while still
            // suppressed; a 0ms timeout lands after it.
            setTimeout(() => {
                window._juceRerouteInProgress = Math.max(
                    0, (window._juceRerouteInProgress || 1) - 1);
            }, 0);
        };
        let _resumeScheduled = false;
        try {
            await jucePlayer.pause().catch(() => {});
            if (_isStale(songAudio)) return;           // song changed mid-pause
            window._juceMode = false;
            window._juceAudioUrl = null;
            audio.src = url;
            audio.load();
            const _spSlider = document.getElementById?.('speed-slider');
            if (_spSlider) setSpeed(_spSlider.value / 100);
            // Resume only AFTER the seek so playback starts at `pos`, not at 0
            // with an audible jump once metadata arrives.
            const resumeAtPos = () => {
                try {
                    // The metadata event can land after a fast song switch —
                    // bail before touching currentTime so a stale callback
                    // doesn't seek the newly loaded song to the old position.
                    if (_isStale(songAudio)) return;
                    try { audio.currentTime = pos; } catch (_) { /* ignore */ }
                    // Re-read isPlaying (not the entry snapshot): the user may
                    // have pressed Pause during jucePlayer.pause()/metadata
                    // load — don't resume a song they just paused.
                    if (isPlaying) {
                        audio.play().catch(() => { /* ignore */ });
                    }
                } finally {
                    _releaseSuppression();
                }
            };
            _resumeScheduled = true;
            if (audio.readyState >= 1) {
                resumeAtPos();
            } else {
                // Wait for metadata to resume at `pos`. But metadata may never
                // arrive (bad URL, network error) — that would leak the
                // suppression refcount and permanently silence song:play /
                // song:pause. Guard with the element's 'error' event AND a
                // backstop timeout; whichever fires first wins, the others are
                // detached. _releaseSuppression is idempotent regardless.
                let _settled = false;
                const _onMeta = () => { finish(true); };
                const _onErr = () => { finish(false); };
                let _backstop;
                function finish(reachedMetadata) {
                    if (_settled) return;
                    _settled = true;
                    clearTimeout(_backstop);
                    audio.removeEventListener('loadedmetadata', _onMeta);
                    audio.removeEventListener('error', _onErr);
                    if (reachedMetadata) {
                        resumeAtPos();             // resumeAtPos releases suppression
                    } else {
                        _releaseSuppression();     // no resume — just release
                    }
                }
                audio.addEventListener('loadedmetadata', _onMeta, { once: true });
                audio.addEventListener('error', _onErr, { once: true });
                // 10s is well beyond a normal local-file metadata load.
                _backstop = setTimeout(() => { finish(false); }, 10000);
            }
        } finally {
            // resumeAtPos owns the release once scheduled; if we returned
            // early (stale, before scheduling) release here instead.
            // _releaseSuppression is idempotent so an overlap is harmless.
            if (!_resumeScheduled) _releaseSuppression();
        }
        try {
            const apply = window.slopsmith?.audio?.applySongVolume;
            if (typeof apply === 'function') await apply();
        } catch (_) { /* best-effort */ }
        console.log('[juce-reroute] JUCE → HTML5 @', pos.toFixed(2), 's playing=', wasPlaying);
        window.slopsmith?.playback?.recordRouteChange?.({
            routeKind: 'browser-media',
            state: 'active',
            preservedTime: true,
            safeReason: 'browser media route active',
            requesterId: 'core.juce-route',
        });
    }

    async function _reevaluateJuceRouting() {
        if (_rerouteInFlight) return;
        const songAudio = window._currentSongAudio;
        // Only /audio/ songs are JUCE-routable; sloppak stems stay on HTML5.
        if (!songAudio || !songAudio.juceEligible) return;
        // Don't race highway.js's own initial song-load routing: it owns
        // _juceMode until _juceRoutingPromise settles. Re-running our switch
        // concurrently would double-call loadBackingTrack for the same URL.
        if (window._highwayJuceRoutingPending) return;

        // Claim the in-flight guard SYNCHRONOUSLY, before the first await. The
        // watcher is driven by a 350ms setInterval; if isAudioRunning() (or any
        // later await) stalls past the poll period, a second tick would
        // otherwise pass the `if (_rerouteInFlight) return` check above and run
        // a concurrent switch — duplicate loadBackingTrack IPCs racing on
        // _juceMode / audio.src. Setting it here closes that window.
        _rerouteInFlight = true;
        try {
            let running;
            try { running = await juceApi.isAudioRunning(); }
            catch (_) { return; }
            if (_isStale(songAudio)) return;               // song changed during IPC
            if (!!running === !!window._juceMode) return;  // routing already consistent

            const wantJuce = running && !window._juceMode;
            // Don't keep retrying a track JUCE explicitly rejected.
            if (wantJuce && songAudio.url === _rerouteRejectedUrl) return;

            if (running) {
                const outcome = await _switchHtml5ToJuce(songAudio);
                // Memoise ONLY an explicit hard JUCE reject. A successful
                // switch clears the memo; a 'stale' abort (song changed
                // mid-flight) leaves it untouched — it must never be
                // misclassified as a reject, even if the song object was
                // swapped and then restored before this point.
                if (outcome === 'rejected') {
                    _rerouteRejectedUrl = songAudio.url;
                } else if (outcome === 'switched') {
                    _rerouteRejectedUrl = null;
                }
                // outcome === 'stale': leave _rerouteRejectedUrl as-is.
            } else {
                await _switchJuceToHtml5(songAudio);
                // The engine just stopped. Clear any hard-reject memo so a
                // later engine restart re-evaluates the track at least once —
                // the rejection may have been a transient device/decoder state.
                _rerouteRejectedUrl = null;
            }
        } catch (e) {
            // Transient failure — log but do NOT memoise, so the next poll retries.
            console.warn('[juce-reroute] re-route failed (will retry):', e);
        } finally {
            _rerouteInFlight = false;
        }
    }
    window._reevaluateJuceRouting = _reevaluateJuceRouting;

    // Clears the hard-reject memo. Called from the song-teardown sites that
    // null window._currentSongAudio (showScreen, playSong) so that reloading
    // the same file later gets a fresh routing attempt — a prior reject may
    // have been a transient JUCE/device state, not a permanent codec issue.
    window._clearJuceRerouteMemo = function () { _rerouteRejectedUrl = null; };

    // The engine can be started/stopped from several places (the desktop Audio
    // Engine panel, the audio_engine plugin, note_detect) and via setDevice
    // restarts — and the contextBridge api object is frozen, so its methods
    // can't be wrapped. Poll isAudioRunning() while a song is loaded; the check
    // is a cheap IPC boolean and no-ops once routing is already consistent.
    // Skip the poll while the document is hidden (background tab / minimised
    // window) — engine toggles there will be reconciled on the first poll
    // after the tab is visible again.
    setInterval(() => {
        if (document.hidden) return;
        if (window._currentSongAudio) void _reevaluateJuceRouting();
    }, 350);
})();

// Desktop JUCE backing uses an empty <audio> element; plugins such as Section Map
// still seek via audio.currentTime / pause / play. Mirror those onto jucePlayer
// while _juceMode is active. Same-tick pause+seek coalesce into a single seek
// (no stopBacking before seek — HTML5 needed that for buffering; JUCE does not).
let _resetJuceAudioShimChain = function () {};
(function _installJuceAudioElementShim() {
    if (!window.slopsmithDesktop?.audio) return;

    const mediaProto = HTMLMediaElement.prototype;
    const ctDesc = Object.getOwnPropertyDescriptor(mediaProto, 'currentTime');
    const pausedDesc = Object.getOwnPropertyDescriptor(mediaProto, 'paused');
    if (!ctDesc?.get || !ctDesc?.set || !pausedDesc?.get) return;

    const nativePlay = mediaProto.play;
    const nativePause = mediaProto.pause;

    let chain = Promise.resolve();
    /** Same-tick pause + seek (Section Map): coalesce to one seek — no stopBacking before seek. */
    let _juceShimBatch = null;
    let _juceShimBatchFlushScheduled = false;
    let _juceShimGen = 0;
    function enqueue(fn) {
        const gen = _juceShimGen;
        const p = chain.then(async () => {
            if (gen !== _juceShimGen) return;
            return fn(gen);
        });
        chain = p.catch((e) => {
            console.warn('[juce-audio-shim]', e);
        });
        return p;
    }
    // forUpcomingPlay: caller will enqueue a play() right after, so don't
    // emit pause-state side effects for a wantsPause batch — play() will
    // overwrite them anyway.
    function flushJuceShimBatchNow({ forUpcomingPlay = false } = {}) {
        _juceShimBatchFlushScheduled = false;
        const batch = _juceShimBatch;
        _juceShimBatch = null;
        if (!batch || !window._juceMode) return;
        const wantsPause = !!batch.wantsPause;
        const seekTime = batch.seekTime;
        if (wantsPause && seekTime !== undefined) {
            enqueue(async (gen) => {
                const r = await _audioSeek(seekTime, 'audio-element-shim');
                if (!r.completed) return; // seek cancelled by teardown
                if (gen !== _juceShimGen) return;
                if (!forUpcomingPlay) {
                    await jucePlayer.pause();
                    if (gen !== _juceShimGen) return;
                    isPlaying = false;
                    setPlayButtonState(false);
                    const sm = window.slopsmith;
                    if (sm) {
                        sm.isPlaying = false;
                        sm.emit('song:pause', _songEventPayload());
                    }
                }
                audio.dispatchEvent(new Event('seeked'));
            });
            return;
        }
        if (wantsPause) {
            enqueue(async (gen) => {
                await jucePlayer.pause();
                if (gen !== _juceShimGen) return;
                isPlaying = false;
                setPlayButtonState(false);
                const sm = window.slopsmith;
                if (sm) {
                    sm.isPlaying = false;
                    sm.emit('song:pause', _songEventPayload());
                }
            });
            return;
        }
        if (seekTime !== undefined) {
            enqueue(async (gen) => {
                const r = await _audioSeek(seekTime, 'audio-element-shim');
                if (!r.completed) return; // seek cancelled by teardown
                if (gen !== _juceShimGen) return;
                audio.dispatchEvent(new Event('seeked'));
            });
        }
    }
    function scheduleJuceShimBatchFlush() {
        if (_juceShimBatchFlushScheduled) return;
        _juceShimBatchFlushScheduled = true;
        const flushGen = _juceShimGen;
        queueMicrotask(() => {
            if (flushGen !== _juceShimGen) {
                _juceShimBatchFlushScheduled = false;
                return;
            }
            flushJuceShimBatchNow();
        });
    }
    _resetJuceAudioShimChain = function () {
        chain = Promise.resolve();
        _juceShimBatch = null;
        _juceShimBatchFlushScheduled = false;
        _juceShimGen++;
    };

    Object.defineProperty(audio, 'currentTime', {
        get() {
            if (window._juceMode) return jucePlayer.currentTime;
            return ctDesc.get.call(this);
        },
        set(v) {
            if (window._juceMode) {
                const t = Math.max(0, Number(v) || 0);
                _juceShimBatch = _juceShimBatch || {};
                _juceShimBatch.seekTime = t;
                scheduleJuceShimBatchFlush();
                return;
            }
            ctDesc.set.call(this, v);
        },
        configurable: true,
    });

    Object.defineProperty(audio, 'paused', {
        get() {
            if (window._juceMode) return !isPlaying;
            return pausedDesc.get.call(this);
        },
        configurable: true,
    });

    audio.pause = function () {
        if (window._juceMode) {
            _juceShimBatch = _juceShimBatch || {};
            _juceShimBatch.wantsPause = true;
            scheduleJuceShimBatchFlush();
            return;
        }
        nativePause.call(audio);
    };

    audio.play = function () {
        if (window._juceMode) {
            if (_juceShimBatch != null) flushJuceShimBatchNow({ forUpcomingPlay: true });
            const p = enqueue(async (gen) => {
                const started = await jucePlayer.play();
                if (gen !== _juceShimGen || !started) return;
                isPlaying = true;
                setPlayButtonState(true);
                const sm = window.slopsmith;
                if (sm) {
                    sm.isPlaying = true;
                    const payload = _songEventPayload();
                    sm.emit('song:play', payload);
                    sm.emit('song:resume', payload);
                }
            });
            return p.then(() => undefined);
        }
        return nativePlay.call(audio);
    };
})();

function _audioTime() { return window._juceMode ? jucePlayer.currentTime : audio.currentTime; }
function _audioDuration() { return window._juceMode ? jucePlayer.duration : audio.duration; }
// Canonical payload for song:play/song:pause/song:ended. Plugins anchor
// their own clocks against `perfNow` (a monotonic timestamp at the same
// moment audio reports `audioT`) so they don't have to chase the chart
// clock with a follow-up call. `time` is kept as an alias for `audioT`
// because pre-existing plugins read e.detail.time.
function _songEventPayload() {
    const audioT = _audioTime();
    return {
        time: audioT,
        audioT,
        chartT: highway.getTime(),
        perfNow: performance.now(),
    };
}

function _markPlaybackPaused() {
    isPlaying = false;
    setPlayButtonState(false);
    if (window.slopsmith) {
        window.slopsmith.isPlaying = false;
        window.slopsmith.emit('song:pause', _songEventPayload());
    }
}

function _markPlaybackResumed() {
    isPlaying = true;
    setPlayButtonState(true);
    if (window.slopsmith) {
        window.slopsmith.isPlaying = true;
        const payload = _songEventPayload();
        window.slopsmith.emit('song:play', payload);
        window.slopsmith.emit('song:resume', payload);
    }
}

function _emitPlaybackStopped(time, screen = 'playback-command') {
    if (window.slopsmith) window.slopsmith.emit('song:stop', { time: time || 0, screen });
}

function _waitForSongReady(expectedSeekGen, timeoutMs = 10000) {
    if (!window.slopsmith || typeof window.slopsmith.on !== 'function') return Promise.resolve(false);
    return new Promise(resolve => {
        let timer = null;
        const done = value => {
            if (timer !== null) clearTimeout(timer);
            window.slopsmith.off('song:ready', onReady);
            resolve(value);
        };
        const onReady = () => done(expectedSeekGen == null || expectedSeekGen === _audioSeekGen);
        window.slopsmith.on('song:ready', onReady);
        timer = setTimeout(() => done(false), timeoutMs);
    });
}
// Serializes seeks so concurrent callers (e.g. user ⏪ during a loop wrap)
// don't interleave their from/to reads — each call captures `from` only
// once the previous seek + emit have completed. The generation token
// lets session teardown invalidate queued seeks so they don't run against
// the new player and emit a stale song:seek.
let _audioSeekChain = Promise.resolve();
let _audioSeekGen = 0;
function _resetAudioSeekState() {
    // Bump the generation — in-flight chain callbacks see the mismatch on
    // their next guard check and short-circuit (no emit, no further state
    // mutation by us). Don't reset the chain head: new seeks must still
    // queue behind the in-flight old seek's IPC so two `jucePlayer.seek()`
    // calls can't race in the JUCE backing engine. The queue drains
    // quickly because each subsequent old-gen step bails on the first
    // guard the moment its predecessor resolves.
    _audioSeekGen++;
}
// Time-box the JUCE IPC so a single hung seek can't block the global
// _audioSeekChain forever (which would freeze every subsequent reposition
// path: seekBy, loop-wrap, jump-fix, shimmed audio.currentTime).
const _JUCE_SEEK_TIMEOUT_MS = 2000;
function _juceSeekWithTimeout(s) {
    let timer;
    const seekP = jucePlayer.seek(s);
    const timeoutP = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('JUCE seek timed out')), _JUCE_SEEK_TIMEOUT_MS);
    });
    // Clear the timer once the race settles either way; without this the
    // pending timeout keeps the event loop alive (and eventually rejects
    // an unawaited promise) even after a successful seek.
    return Promise.race([seekP, timeoutP]).finally(() => clearTimeout(timer));
}
// Resolves to `{ completed, from, to }`:
//   - completed: true if the seek ran to completion and emitted song:seek;
//                false if cancelled by a teardown gen bump (or threw).
//   - from: chart clock just before the seek (NaN on cancel before from-read).
//   - to:   verified post-seek clock (NaN on cancel/throw).
// Callers that fire follow-up work after the seek (count-in, arrangement
// restore, etc.) should check `completed` so they don't act on a torn-down
// session. Callers that need the actual landed position (because JUCE may
// clamp or HTML5 may snap to the seekable range) should read `to` rather
// than re-using the requested `s`.
async function _audioSeek(s, reason) {
    // Single funnel for every audio repositioning. Emits song:seek so
    // plugins (notedetect detection-suppression during seek transients,
    // practice-journal segment tracking) can react to any chart-time
    // jump regardless of which UI path triggered it. `reason` is a
    // free-form short string ('seek-by', 'loop-wrap', 'loop-set',
    // 'arrangement-restore', 'jump-fix') so subscribers can filter.
    const gen = _audioSeekGen;
    _audioSeekChain = _audioSeekChain.then(async () => {
        if (gen !== _audioSeekGen) return { completed: false, from: NaN, to: NaN };
        const from = _audioTime();
        if (window._juceMode) await _juceSeekWithTimeout(s);
        else audio.currentTime = s;
        if (gen !== _audioSeekGen) return { completed: false, from, to: NaN };
        // Read the verified post-seek position rather than the requested `s`
        // so plugins observe the actual clock — JUCE may clamp or roll back,
        // and HTML5 may snap to the nearest seekable range.
        const to = _audioTime();
        // Sync the jump-fix tracker so the next 60Hz tick doesn't see a
        // legitimate far seek (e.g. saved-loop jump > 30s) as a browser
        // bug and revert it.
        lastAudioTime = to;
        // Sync the chart clock too so any song:* emit fired right after
        // _audioSeek resolves (e.g. the auto-resume song:play in
        // changeArrangement) sees an in-sync chartT via _songEventPayload.
        // Without this, chartT lags by one 60Hz tick after a seek.
        if (typeof highway !== 'undefined' && highway && typeof highway.setTime === 'function') {
            highway.setTime(to);
        }
        window.slopsmith.emit('song:seek', { from, to, reason: reason || null });
        return { completed: true, from, to };
    }).catch((err) => {
        // Don't let one failed seek poison subsequent ones.
        console.warn('[_audioSeek]', err);
        return { completed: false, from: NaN, to: NaN };
    });
    return _audioSeekChain;
}
let currentFilename = '';

// Plugin context API — lightweight event bus for plugin integration
// Preserve any namespace attached by earlier-loaded scripts (e.g.
// diagnostics.js, slopsmith#166) so reassigning the root doesn't drop
// their public APIs. Only `slopsmith.diagnostics` exists today, but
// the snapshot pattern is intentional: it keeps app.js the
// authoritative owner of the EventTarget while letting other modules
// hang their surfaces off the same namespace without coordinating
// load order.
const _slopsmithExisting = (typeof window.slopsmith === 'object' && window.slopsmith !== null) ? window.slopsmith : null;
const _slopsmithBus = (_slopsmithExisting
    && typeof _slopsmithExisting.addEventListener === 'function'
    && typeof _slopsmithExisting.removeEventListener === 'function'
    && typeof _slopsmithExisting.dispatchEvent === 'function')
    ? _slopsmithExisting
    : new EventTarget();
window.slopsmith = Object.assign(_slopsmithBus, {
    currentSong: null,
    isPlaying: false,
    _navParams: {},
    navigate(screenId, params) {
        this._navParams = params || {};
        showScreen(screenId);
    },
    getNavParams() {
        const p = this._navParams;
        this._navParams = {};
        return p;
    },
    emit(event, detail) {
        this.dispatchEvent(new CustomEvent(event, { detail }));
    },
    on(event, fn, options) {
        this.addEventListener(event, fn, options);
    },
    off(event, fn, options) { this.removeEventListener(event, fn, options); },
    // Loop API — plugins should never reach for #btn-loop-* directly.
    // The script-scope `setLoop` and `clearLoop` are hoisted so these
    // method bodies resolve them lexically; `getLoop` reads the live
    // loopA/loopB bindings at call time.
    seek(seconds, reason, options) {
        _recordPlaybackBridge('playback.window-slopsmith-transport', 'window.slopsmith.seek', reason || 'plugin-command');
        return _audioSeek(seconds, reason || 'plugin-command');
    },
    setLoop(a, b, options) {
        _recordPlaybackBridge('playback.loop-api', 'window.slopsmith.setLoop', options && options.reason || 'plugin-command');
        return setLoop(a, b, options);
    },
    clearLoop(options) {
        _recordPlaybackBridge('playback.loop-api', 'window.slopsmith.clearLoop', options && options.reason || 'plugin-command');
        clearLoop(options);
    },
    getLoop(options) {
        _recordPlaybackBridge('playback.loop-api', 'window.slopsmith.getLoop', options && options.reason || 'plugin-command');
        return { loopA, loopB };
    },
});
if (_slopsmithExisting && _slopsmithExisting !== window.slopsmith) {
    for (const key of Object.keys(_slopsmithExisting)) {
        if (!(key in window.slopsmith)) {
            window.slopsmith[key] = _slopsmithExisting[key];
        }
    }
}

function _playbackApi() {
    return window.slopsmith && window.slopsmith.playback && window.slopsmith.playback.version === 1
        ? window.slopsmith.playback
        : null;
}

function _recordPlaybackBridge(bridgeId, legacySurface, reason) {
    const playback = _playbackApi();
    if (!playback || typeof playback.recordBridgeHit !== 'function') return;
    playback.recordBridgeHit({
        bridgeId,
        legacySurface,
        source: 'core.app',
        reason: reason || 'legacy playback surface used',
    });
}

function _currentPlaybackSnapshot() {
    const song = window.slopsmith && window.slopsmith.currentSong || null;
    const time = _audioTime();
    return {
        currentTime: Number.isFinite(time) ? time : null,
        mediaTime: Number.isFinite(time) ? time : null,
        chartTime: (typeof highway !== 'undefined' && highway && typeof highway.getTime === 'function') ? highway.getTime() : null,
        duration: Number.isFinite(_audioDuration()) ? _audioDuration() : (song && song.duration) || null,
        playbackRate: window._juceMode ? (window.jucePlayer && window.jucePlayer._speed || 1) : audio.playbackRate,
        isPlaying,
        readiness: song ? 'ready' : 'idle',
        routeKind: window._juceMode ? 'desktop-native' : 'browser-media',
        routeState: song || audio.src || window._juceAudioUrl ? 'active' : 'unavailable',
        loopA,
        loopB,
        loop: loopA !== null && loopB !== null ? { startTime: loopA, endTime: loopB, enabled: true, state: 'active' } : { enabled: false, state: 'inactive' },
        currentSong: song ? {
            targetId: song.filename ? `target-${String(song.filename).length}-${String(song.arrangementIndex ?? song.arrangement ?? '').length}` : undefined,
            sourceKind: song.format || 'local',
            format: song.format || 'unknown',
            arrangementRef: song.arrangementIndex != null ? `arrangement-${song.arrangementIndex}` : song.arrangement,
            localDisplay: {
                title: song.title,
                artist: song.artist,
                arrangement: song.arrangementSmartName || song.arrangement,
            },
        } : null,
    };
}

function _installPlaybackTransportAdapter() {
    const playback = _playbackApi();
    if (!playback || typeof playback.registerTransportAdapter !== 'function') return;
    playback.registerTransportAdapter({
        inspect() {
            return _currentPlaybackSnapshot();
        },
        async start(args) {
            const target = args && args.target || {};
            const filename = target.filename || target.id || target.songKey || (target.localDisplay && target.localDisplay.filename) || currentFilename;
            if (!filename) throw new Error('No playback filename available');
            // playSong() and the highway WS decodeURIComponent the filename, so a
            // raw name with a literal '%' (e.g. "Song 50%.psarc") would throw
            // URIError. Normalize to the encoded form playSong expects: pass it
            // through if it already decodes cleanly, otherwise encode it.
            let playbackFilename = filename;
            try { decodeURIComponent(playbackFilename); }
            catch (_) { playbackFilename = encodeURIComponent(filename); }
            const shouldSeekStart = Number.isFinite(Number(args && args.startTime));
            const expectedSeekGen = _audioSeekGen + 1;
            const ready = shouldSeekStart ? _waitForSongReady(expectedSeekGen) : null;
            await playSong(playbackFilename, args && args.arrangement, { bridge: false });
            const becameReady = ready ? await ready : true;
            if (shouldSeekStart && !becameReady) {
                throw new Error('Playback did not become ready before applying startTime');
            }
            if (shouldSeekStart) {
                await _audioSeek(Number(args.startTime), 'playback-start');
            }
            return _currentPlaybackSnapshot();
        },
        async pause() {
            const wasPlaying = isPlaying;
            if (!window._juceMode && wasPlaying) {
                isPlaying = false;
                window.slopsmith.isPlaying = false;
                audio.pause();
                _markPlaybackPaused();
            } else {
                if (window._juceMode) await jucePlayer.pause();
                else audio.pause();
                if (wasPlaying) _markPlaybackPaused();
                else { isPlaying = false; window.slopsmith.isPlaying = false; setPlayButtonState(false); }
            }
            return _currentPlaybackSnapshot();
        },
        async resume() {
            if (window._juceMode) {
                const started = await jucePlayer.play();
                if (!started) return { unavailable: true, reason: 'desktop backing transport unavailable' };
                _markPlaybackResumed();
            } else {
                await audio.play();
                isPlaying = true;
                window.slopsmith.isPlaying = true;
                setPlayButtonState(true);
            }
            return _currentPlaybackSnapshot();
        },
        async stop() {
            const stopTime = _audioTime();
            const hadPlayableSong = !!audio.src || !!window._juceAudioUrl || isPlaying;
            const wasPlaying = isPlaying;
            if (window._juceMode) await jucePlayer.stop().catch(() => {});
            if (!window._juceMode && wasPlaying) {
                isPlaying = false;
                window.slopsmith.isPlaying = false;
                audio.pause();
                _markPlaybackPaused();
            } else {
                // HTML5 only. In JUCE mode jucePlayer.stop() already stopped the
                // engine; the audio.pause() shim would just queue a redundant
                // jucePlayer.pause() and a duplicate (or, when not playing,
                // spurious) song:pause.
                if (!window._juceMode) audio.pause();
                if (wasPlaying) _markPlaybackPaused();
                else { isPlaying = false; window.slopsmith.isPlaying = false; setPlayButtonState(false); }
            }
            if (hadPlayableSong) _emitPlaybackStopped(stopTime);
            return _currentPlaybackSnapshot();
        },
        seek({ time, reason }) {
            const seconds = Number(time);
            if (!Number.isFinite(seconds) || seconds < 0) {
                throw new Error(`Invalid seek time: ${time}`);
            }
            return _audioSeek(seconds, reason || 'playback-command');
        },
        setLoop({ startTime, endTime }) {
            return setLoop(startTime, endTime, { emitTransportEvent: false });
        },
        clearLoop() {
            clearLoop({ emitTransportEvent: false });
            return _currentPlaybackSnapshot();
        },
    });
}

_installPlaybackTransportAdapter();

// Initialise volume from persisted preference (matches lefty / invertHighway /
// renderScale / showLyrics convention). The mixer popover (audio-mixer.js)
// owns the UI surface; this just hydrates audio.volume on boot.
function _readSongVolume() {
    try {
        const stored = parseFloat(localStorage.getItem('volume'));
        return Number.isFinite(stored) ? Math.min(100, Math.max(0, stored)) : 80;
    } catch (e) {
        return 80;
    }
}
audio.volume = _readSongVolume() / 100;

function _adjustSongVolume(delta) {
    const audioApi = window.slopsmith?.audio;
    if (!audioApi) return;
    const current = audioApi.readSongVolume?.() ?? 80;
    const next = Math.max(0, Math.min(100, Math.round(current + delta)));
    const songFader = audioApi.getFaders?.().find(f => f.id === 'song');
    if (songFader) songFader.setValue(next);
}

// Re-sync audio.volume from the persisted setting whenever a new source
// finishes loading metadata. Belt + suspenders — some combinations of plugin
// audio-graph routing and media-element swaps reset audio.volume to 1.0
// (slopsmith#54). Delegates to audio-mixer's readSongVolume when loaded so
// the in-memory fallback (for storage-blocked contexts) is authoritative.
audio.addEventListener('loadedmetadata', () => {
    _applyPreservePitch(audio);
    const applySongVolume = window.slopsmith?.audio?.applySongVolume;
    if (typeof applySongVolume === 'function') {
        void applySongVolume();
    } else {
        audio.volume = (window.slopsmith?.audio?.readSongVolume?.() ?? _readSongVolume()) / 100;
    }
});

// Debug audio issues
audio.addEventListener('pause', () => {
    // The JUCE engine-reroute watcher pauses the element on purpose mid-migration
    // (and the src='' it does fires a trailing async pause too); don't flag those
    // as unexpected — the watcher holds window._juceRerouteInProgress across it.
    if (isPlaying && !window._juceRerouteInProgress) {
        console.log('Audio paused unexpectedly at', audio.currentTime.toFixed(1));
    }
});
audio.addEventListener('error', (e) => {
    // Ignore errors from empty src (happens during song switch cleanup)
    if (!audio.src || audio.src === window.location.href) return;
    console.error('Audio error:', audio.error?.code, audio.error?.message);
});
audio.addEventListener('stalled', () => console.log('Audio stalled at', audio.currentTime.toFixed(1)));
audio.addEventListener('waiting', () => console.log('Audio waiting/buffering at', audio.currentTime.toFixed(1)));
audio.addEventListener('ended', () => {
    console.log('Audio ended'); isPlaying = false;
    setPlayButtonState(false);
    window.slopsmith.isPlaying = false;
    window.slopsmith.emit('song:ended', _songEventPayload());
});
audio.addEventListener('timeupdate', () => {
    _emitSongPositionChanged(audio.currentTime, audio.duration || null);
});
audio.addEventListener('play', () => {
    // During a JUCE engine reroute the element is paused/played as a transparent
    // migration step — playback genuinely continues, so don't emit song:play or
    // flip slopsmith.isPlaying (the watcher keeps the canonical state itself).
    if (window._juceRerouteInProgress) return;
    window.slopsmith.isPlaying = true;
    const payload = _songEventPayload();
    window.slopsmith.emit('song:play', payload);
    window.slopsmith.emit('song:resume', payload);
});
audio.addEventListener('pause', () => {
    if (!isPlaying) return;
    // Same as above: suppress the song:pause emitted by a reroute's deliberate
    // audio.pause() — the migration is transparent to plugin play-state.
    if (window._juceRerouteInProgress) return;
    window.slopsmith.isPlaying = false;
    window.slopsmith.emit('song:pause', _songEventPayload());
});

// Abort controller for cancelling pending requests when entering player
let artAbortController = null;
// Monotonic token so overlapping playSong() calls don't each open a WS.
let _playSongSeq = 0;

async function playSong(filename, arrangement, options) {
    const loadSeq = ++_playSongSeq;
    console.log('playSong called:', filename, 'seq', loadSeq);
    if (!options || options.bridge !== false) {
        _recordPlaybackBridge('playback.window-play-song', 'window.playSong', 'legacy playSong entry point used');
    }
    window.slopsmith.emit('song:loading', { filename, arrangement: arrangement ?? null });

    // Cancel any pending art/metadata requests
    if (artAbortController) artAbortController.abort();
    artAbortController = null;

    highway.stop();
    // Cancel any active count-in: clear timers/RAF and bump the gen so
    // delayed callbacks (rewind frames, post-seek then, count-in ticks,
    // post-count play) bail before mutating the new session.
    _cancelCountIn();
    // Reset the JUCE shim BEFORE awaiting jucePlayer.stop() so any in-flight
    // shim closures see a stale generation after their await and bail out
    // before mutating isPlaying / button label / song:* events for the
    // outgoing song.
    _resetJuceAudioShimChain();
    // Cancel queued _audioSeek calls from the previous song: bumping the
    // generation makes their chained callbacks bail out.
    _resetAudioSeekState();
    if (window._juceMode) {
        // Mirror the showScreen teardown: emit song:pause for the JUCE
        // path so plugins don't see a stale "playing" state on song
        // change. (HTML5 fires it via the audio element 'pause' event.)
        // Snapshot payload BEFORE stop() resets _pos so audioT/chartT
        // capture the actual paused position.
        const payload = _songEventPayload();
        const wasPlaying = isPlaying;
        await jucePlayer.stop().catch(() => {});
        if (wasPlaying && window.slopsmith) {
            window.slopsmith.isPlaying = false;
            window.slopsmith.emit('song:pause', payload);
        }
        window._juceMode = false;
        window._juceAudioUrl = null;
    }
    audio.pause();
    audio.src = '';
    // Stale until the incoming song's WS handler (highway.js) sets it again.
    window._currentSongAudio = null;
    // Fresh JUCE routing attempt for whatever song loads next.
    window._clearJuceRerouteMemo?.();
    isPlaying = false;
    setPlayButtonState(false);
    document.getElementById('speed-slider').value = 100;
    handleSliderInput(document.getElementById('speed-slider'));
    document.getElementById('speed-label').textContent = '1.0x';
    _updateSpeedQualityHint(1);
    _updateSpeedPresetButtons(100);
    _ensureSpeedSliderWired();
    clearLoop();
    _resetSectionPracticeLog();
    _hideSectionPracticeBar();

    currentFilename = filename;
    // Remember which screen the player was launched from so Esc /
    // navigation back from the player returns the user there
    // (slopsmith#126). Falls back to 'home' if launched from
    // somewhere unexpected (settings, a plugin screen, etc.).
    const _launchFrom = document.querySelector('.screen.active');
    _playerOriginScreen = (_launchFrom && (_launchFrom.id === 'home' || _launchFrom.id === 'favorites'))
        ? _launchFrom.id : 'home';
    showScreen('player');

    // Wait for previous WebSocket to fully close before opening new one
    await new Promise(r => setTimeout(r, 500));
    if (loadSeq !== _playSongSeq) {
        console.log('[arr] playSong superseded before connect', filename);
        return;
    }
    highway.init(document.getElementById('highway'));

    const wsParams = new URLSearchParams();
    if (arrangement !== undefined) wsParams.set('arrangement', arrangement);
    wsParams.set('naming_mode', _getArrangementNamingMode());
    const wsUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/highway/${decodeURIComponent(filename)}?${wsParams.toString()}`;
    highway.connect(wsUrl);
    _resetSectionPracticeLog();
    _scheduleSectionPracticeRetries();
    loadSavedLoops();
    document.getElementById('quality-select').value = highway.getRenderScale();
}

// Generation token + safety-timeout handle for changeArrangement's
// aria-busy gate. Module-scoped so a newer invocation cancels the
// previous one's pending timeout (and its _onReady callback bails when
// the gen has moved on) rather than clearing aria-busy for itself.
let _arrBusyGen = 0;
let _arrBusyTimeout = null;

async function changeArrangement(index) {
    console.log('[arr] selected', index);
    if (currentFilename) {
        window.slopsmith.emit('song:arrangement-changed', { filename: currentFilename, arrangement: index });
        const wasPlaying = isPlaying;
        const time = _audioTime();
        if (isPlaying) {
            if (window._juceMode) await jucePlayer.pause();
            else audio.pause();
            isPlaying = false;
        }

        // Audio is paused, but the play button is intentionally left
        // showing its pre-load state to avoid flicker if auto-resume
        // succeeds. Tell assistive tech to wait until the load +
        // seek-restore + auto-resume settles before re-announcing the
        // button so screen readers don't briefly advertise stale state.
        // Pair with a safety timeout so a websocket/server failure that
        // never reaches `ready` can't leave the button perpetually busy.
        const myGen = ++_arrBusyGen;
        const playBtn = document.getElementById('btn-play');
        if (playBtn) playBtn.setAttribute('aria-busy', 'true');
        if (_arrBusyTimeout !== null) clearTimeout(_arrBusyTimeout);
        _arrBusyTimeout = setTimeout(() => {
            if (myGen !== _arrBusyGen) return;
            _arrBusyTimeout = null;
            const b = document.getElementById('btn-play');
            if (b) b.removeAttribute('aria-busy');
        }, 30000);

        // Show loading overlay
        let overlay = document.getElementById('arr-loading');
        if (overlay) overlay.remove();
        overlay = document.createElement('div');
        overlay.id = 'arr-loading';
        overlay.className = 'fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm';
        overlay.innerHTML = `
            <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-72 text-center shadow-2xl">
                <div class="text-sm text-gray-300 mb-3">Loading arrangement...</div>
                <div class="progress-bar"><div class="fill" style="width:30%;animation:pulse 1s infinite"></div></div>
            </div>`;
        document.body.appendChild(overlay);

        // Set callback for when data is ready. Capture the function ref
        // so a stale older invocation firing after a newer changeArrangement
        // has installed its own callback can't clobber the newer one.
        const myCallback = async () => {
            // Bail in full if this invocation has been superseded. The newer
            // changeArrangement owns the overlay (same id), its own _onReady,
            // and the aria-busy gate; this old callback must not touch any
            // of them.
            if (myGen !== _arrBusyGen) return;
            const ol = document.getElementById('arr-loading');
            if (ol) ol.remove();
            const clearBusy = () => {
                // Double-checked because a newer invocation could land
                // during the await below.
                if (myGen !== _arrBusyGen) return;
                if (_arrBusyTimeout !== null) {
                    clearTimeout(_arrBusyTimeout);
                    _arrBusyTimeout = null;
                }
                const b = document.getElementById('btn-play');
                if (b) b.removeAttribute('aria-busy');
            };
            const clearMyCallback = () => {
                // Only null out if the slot still points at us; a newer
                // invocation may have replaced it during the await.
                if (highway._onReady === myCallback) highway._onReady = null;
            };
            const r = await _audioSeek(time, 'arrangement-restore');
            // Don't auto-resume on cancel OR off-target landing — same
            // 50 ms tolerance as loop-wrap / loop-set. Resuming play from
            // a different position than the user's previous play position
            // would be jarring; better to leave them at the post-seek
            // (likely close-but-not-equal) position without auto-play.
            if (!r.completed || Math.abs(r.to - time) > 0.05) {
                // changeArrangement paused audio at entry (line 3032) but
                // didn't update the button or emit song:pause — those were
                // meant to be no-ops if the auto-resume succeeded. On
                // abort, sync the transport: button -> 'Play',
                // sm.isPlaying = false, emit song:pause so plugins see the
                // paused state.
                if (wasPlaying) {
                    setPlayButtonState(false);
                    if (window.slopsmith) {
                        window.slopsmith.isPlaying = false;
                        window.slopsmith.emit('song:pause', _songEventPayload());
                    }
                }
                clearBusy();
                clearMyCallback();
                return;
            }
            if (wasPlaying) {
                if (window._juceMode) {
                    const started = await jucePlayer.play();
                    if (started) {
                        isPlaying = true;
                        window.slopsmith.isPlaying = true;
                        const payload = _songEventPayload();
                        window.slopsmith.emit('song:play', payload);
                        window.slopsmith.emit('song:resume', payload);
                    }
                } else if (audio.src && audio.src !== window.location.href) {
                    audio.play().then(() => { isPlaying = true; }).catch(() => {});
                }
            }
            clearBusy();
            clearMyCallback();
        };
        highway._onReady = myCallback;

        highway.reconnect(currentFilename, index);
        window.slopsmith.emit('arrangement:changed', { index, filename: currentFilename });
    }
}

// Per-attempt counter for HTML5 audio.play() invocations. Bumped on
// every play branch entry so a slow rejection from attempt N can't
// clobber the UI of a newer attempt N+1 within the same session.
let _playAttemptGen = 0;

async function togglePlay() {
    if (window._juceMode) {
        if (isPlaying) {
            await jucePlayer.pause();
            isPlaying = false;
            setPlayButtonState(false);
            window.slopsmith.isPlaying = false;
            window.slopsmith.emit('song:pause', _songEventPayload());
        } else {
            const started = await jucePlayer.play();
            if (!started) return; // startBacking() failed — IPC error already logged
            isPlaying = true;
            setPlayButtonState(true);
            window.slopsmith.isPlaying = true;
            const payload = _songEventPayload();
            window.slopsmith.emit('song:play', payload);
            window.slopsmith.emit('song:resume', payload);
        }
        return;
    }
    if (isPlaying) {
        audio.pause(); isPlaying = false;
        setPlayButtonState(false);
    } else {
        // After JUCE routing, audio.src is cleared — play() would reject with
        // NotSupportedError even though backing is handled natively.
        if (!audio.src || audio.src === window.location.href) {
            console.warn('[audio] HTML5 play skipped — no source (use JUCE backing)');
            return;
        }
        // Flip the UI optimistically before awaiting the play() Promise so
        // a quick second click during a slow start (buffering, device
        // wake, etc.) still enters the pause branch above. Two stale-
        // resolution guards:
        //   - _audioSeekGen: bumped in showScreen() teardown and
        //     playSong(), so a rejection from a torn-down session can't
        //     touch new-session UI. Survives same-URL reloads.
        //   - _playAttemptGen: bumped on every play branch entry, so
        //     within a single session a slow rejection from attempt N
        //     can't clobber a faster attempt N+1 (Play → Pause → Play).
        const sessionGen = _audioSeekGen;
        const attempt = ++_playAttemptGen;
        isPlaying = true;
        setPlayButtonState(true);
        try {
            await audio.play();
        } catch (err) {
            if (sessionGen !== _audioSeekGen) return;
            if (attempt !== _playAttemptGen) return;
            console.error('[app] audio.play() rejected:', err);
            isPlaying = false;
            setPlayButtonState(false);
        }
    }
}

async function seekBy(s) {
    await _audioSeek(Math.max(0, _audioTime() + s), 'seek-by');
}

/** True when song backing is routed through the desktop JUCE engine. */
function _useJuceBacking() {
    return !!(window._juceMode || window._juceAudioUrl);
}

// ── Playback speed UX — V1 stable core (SoundTouch realtime; engine-swappable) ──
/** Locked V1 musician practice targets — primary workflow. */
const SPEED_PRESET_PCTS = [100, 90, 80, 75, 70, 60, 50];
const SPEED_SWEET_SPOT_PCTS = [80, 75, 70];
const SPEED_SNAP_THRESHOLD = 0.02;
const SPEED_SLIDER_MIN = 25;
const SPEED_SLIDER_MAX = 150;

function _speedSliderPosPct(pct) {
    return ((pct - SPEED_SLIDER_MIN) / (SPEED_SLIDER_MAX - SPEED_SLIDER_MIN)) * 100;
}

function _initSpeedSliderTicks() {
    const wrap = document.getElementById('speed-slider-ticks');
    if (!wrap || wrap.dataset.built === '1') return;
    wrap.dataset.built = '1';
    const sweetLo = Math.min(...SPEED_SWEET_SPOT_PCTS);
    const sweetHi = Math.max(...SPEED_SWEET_SPOT_PCTS);
    const band = document.createElement('div');
    band.className = 'speed-slider-sweetspot';
    band.style.left = _speedSliderPosPct(sweetLo) + '%';
    band.style.width = (_speedSliderPosPct(sweetHi) - _speedSliderPosPct(sweetLo)) + '%';
    wrap.appendChild(band);
    for (const pct of SPEED_PRESET_PCTS) {
        const tick = document.createElement('span');
        const isSweet = pct >= sweetLo && pct <= sweetHi;
        tick.className = 'speed-slider-tick' + (isSweet ? ' speed-slider-tick-sweet' : '');
        tick.style.left = _speedSliderPosPct(pct) + '%';
        wrap.appendChild(tick);
    }
}

function _speedQualityLabel(rate) {
    if (rate >= 0.8) return 'High Quality';
    if (rate >= 0.6) return 'Practice Quality';
    return 'Extreme Slowdown';
}

function _snapSpeedRate(rate) {
    if (!Number.isFinite(rate)) return rate;
    for (const pct of SPEED_PRESET_PCTS) {
        const preset = pct / 100;
        if (Math.abs(rate - preset) <= SPEED_SNAP_THRESHOLD) return preset;
    }
    return rate;
}

function _updateSpeedQualityHint(rate) {
    const hint = document.getElementById('speed-quality-hint');
    if (!hint) return;
    const next = _speedQualityLabel(rate);
    if (hint.textContent === next) return;
    hint.classList.add('speed-quality-hint-fade');
    requestAnimationFrame(() => {
        hint.textContent = next;
        hint.classList.remove('speed-quality-hint-fade');
    });
}

function _updateSpeedPresetButtons(activePct) {
    const wrap = document.getElementById('speed-presets');
    if (!wrap) return;
    const target = Number.isFinite(activePct) ? Math.round(activePct) : null;
    for (const btn of wrap.querySelectorAll('[data-speed-preset]')) {
        const pct = Number(btn.dataset.speedPreset);
        btn.classList.toggle('speed-preset-active', target !== null && pct === target);
    }
}

function applySpeedPreset(percent) {
    const slider = document.getElementById('speed-slider');
    if (!slider) return;
    const pct = Math.max(Number(slider.min) || 25, Math.min(Number(slider.max) || 150, Number(percent)));
    slider.value = String(pct);
    handleSliderInput(slider);
    _updateSpeedPresetButtons(pct);
    void setSpeed(pct / 100);
}
window.applySpeedPreset = applySpeedPreset;

// Public hook for future engines (Rubber Band, Elastique, offline stretch, etc.).
window.slopsmithPlayback = window.slopsmithPlayback || {};
window.slopsmithPlayback.speed = {
    engine: 'soundtouch-realtime',
    profile: 'musician-practice-v1',
    availableEngines: ['soundtouch-realtime'],
    presets: SPEED_PRESET_PCTS,
    sweetSpot: SPEED_SWEET_SPOT_PCTS,
    snapThreshold: SPEED_SNAP_THRESHOLD,
    setRate(rate) { return setSpeed(rate); },
    applyPreset(percent) { applySpeedPreset(percent); },
    snapRate(rate) { return _snapSpeedRate(rate); },
    qualityLabel(rate) { return _speedQualityLabel(rate); },
};

async function setSpeed(v) {
    const speedSlider = document.getElementById('speed-slider');
    const rate = Number(v);
    console.log('[setSpeed]', rate);
    if (!Number.isFinite(rate) || rate <= 0) {
        console.warn('[setSpeed] ignored invalid rate:', v);
        return;
    }
    const speedLabel = document.getElementById('speed-label');
    if (speedLabel) speedLabel.textContent = rate.toFixed(2) + 'x';
    _updateSpeedQualityHint(rate);
    _updateSpeedPresetButtons(Math.round(rate * 100));
    handleSliderInput(speedSlider);

    const useJuce = _useJuceBacking();
    if (useJuce) {
        window.jucePlayer?.setRate(rate);
        const juceAudio = window.slopsmithDesktop?.audio;
        const setBackingSpeed = juceAudio?.setBackingSpeed;
        if (typeof setBackingSpeed !== 'function') {
            console.warn('[setSpeed] JUCE backing active but audio.setBackingSpeed is unavailable');
            return;
        }
        window._lastBackingSpeedReq = rate;
        try {
            const ok = await setBackingSpeed(rate);
            console.log('[setSpeed] setBackingSpeed →', ok);
            if (ok === false) {
                console.warn('[setSpeed] native engine rejected speed', rate);
            }
            await juceAudio?.setBackingPreservePitch?.(true);
        } catch (err) {
            console.warn('[setSpeed] backing speed/preserve-pitch failed:', err);
        }
        return;
    }
    audio.playbackRate = rate;
    if ('preservesPitch' in audio) audio.preservesPitch = true;
}
window.setSpeed = setSpeed;

function _ensureSpeedSliderWired() {
    if (window.__speedSliderWired) return;
    window.__speedSliderWired = true;
    const slider = document.getElementById('speed-slider');
    if (!slider) return;

    const presets = document.getElementById('speed-presets');
    if (presets && !presets._speedPresetsWired) {
        presets._speedPresetsWired = true;
        presets.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-speed-preset]');
            if (!btn) return;
            applySpeedPreset(Number(btn.dataset.speedPreset));
        });
    }

    slider.addEventListener('pointerdown', () => {
        console.log('[slider] pointerdown');
    });
    slider.addEventListener('input', (e) => {
        const rate = Number(e.target.value) / 100;
        console.log('[slider] input', e.target.value);
        _updateSpeedQualityHint(rate);
        void setSpeed(rate);
    });
    slider.addEventListener('change', (e) => {
        let pct = Number(e.target.value);
        const snapped = _snapSpeedRate(pct / 100);
        if (Math.abs(snapped - pct / 100) > 1e-6) {
            pct = Math.round(snapped * 100);
            e.target.value = String(pct);
            handleSliderInput(e.target);
        }
        console.log('[slider] change', e.target.value);
        // Final `input` on release already applied this rate — avoid a second bridge invoke.
        if (window._lastBackingSpeedReq === snapped) return;
        void setSpeed(snapped);
    });

    _initSpeedSliderTicks();
    _updateSpeedQualityHint(Number(slider.value) / 100);
    _updateSpeedPresetButtons(Number(slider.value));
}

window.debugSliderHitTest = () => {
    const slider = document.getElementById('speed-slider');
    if (!slider) return console.log('missing slider');

    const r = slider.getBoundingClientRect();

    const el = document.elementFromPoint(
        r.left + r.width / 2,
        r.top + r.height / 2
    );

    console.log('[slider hit test]', el);
};
// Master-difficulty slider (slopsmith#48). Persists partial via
// /api/settings — the POST handler merges only the keys present, so
// this fire-and-forget call doesn't clobber dlc_dir or other settings.
//
// Debounced trailing-edge (300ms) so dragging the slider — which fires
// oninput per pixel — doesn't flood the server with concurrent writes
// to config.json. highway.setMastery() still fires every oninput so
// the chart re-filters in real time; only disk persistence waits.
let _masteryPersistTimer = null;
function _persistMastery(pct) {
    if (_masteryPersistTimer) clearTimeout(_masteryPersistTimer);
    _masteryPersistTimer = setTimeout(() => {
        _masteryPersistTimer = null;
        fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ master_difficulty: pct }),
        }).catch(() => { /* best-effort — next setMastery() will retry */ });
    }, 300);
}
function setMastery(v) {
    // Guard + clamp: v might be a slider string, a programmatic call
    // from a plugin, or a restored settings value with a bad shape.
    // Don't let NaN hit the label (would show "NaN%") or the POST.
    const parsed = parseInt(v, 10);
    if (!Number.isFinite(parsed)) return;
    const pct = Math.max(0, Math.min(100, parsed));
    document.getElementById('mastery-label').textContent = pct + '%';
    handleSliderInput(document.getElementById('mastery-slider'));
    highway.setMastery(pct / 100);
    _persistMastery(pct);
}
// Reflect phrase-data availability on the slider after every `ready`.
// The server omits the `phrases` message entirely for single-level
// sources (GP imports, legacy sloppak), so hasPhraseData() is the
// right signal to enable/disable the slider.
function _applyMasteryAvailability(hasPhraseData) {
    const slider = document.getElementById('mastery-slider');
    if (!slider) return;
    if (hasPhraseData) {
        slider.disabled = false;
        slider.title = 'Master difficulty — low = simpler chart, high = full';
    } else {
        slider.disabled = true;
        slider.title = 'Source chart has a single difficulty level — slider disabled';
    }
}
if (window.slopsmith) {
    window.slopsmith.on('song:loaded', syncDefaultArrangementPin);
    window.slopsmith.on('arrangement:changed', syncDefaultArrangementPin);
    // slopsmith's event bus dispatches CustomEvent with the payload in
    // event.detail (see EventTarget setup around line 699), so the
    // handler receives an Event, not the raw payload.
    window.slopsmith.on('song:ready', () => {
        _resetSectionPracticeLog();
        renderSectionPracticeBar();
        _scheduleSectionPracticeRetries();
    });
    window.slopsmith.on('song:loaded', () => {
        _scheduleSectionPracticeRetries();
    });
    window.slopsmith.on('song:ready', (e) => {
        _applyMasteryAvailability(!!e.detail?.hasPhraseData);
        // Auto mode: re-evaluate the active renderer against the
        // newly-loaded song. The picker's current <option> value is the
        // source of truth here — localStorage is a persistence mirror
        // that can throw in private / sandboxed contexts, and the
        // picker already reflects fresh-install / post-cleanup
        // fallthroughs to 'auto' even when writes failed.
        const sel = document.getElementById('viz-picker');
        if (sel && sel.value === 'auto') _autoMatchViz();
    });
    // Highway signals when it's auto-reverted to the default renderer
    // after a broken plugin (init failure or repeated draw failures).
    // Sync the picker + persisted selection so the UI stops advertising
    // the broken choice and the user doesn't hit the same failure on
    // next reload.
    window.slopsmith.on('viz:reverted', (e) => {
        const sel = document.getElementById('viz-picker');
        if (sel) sel.value = 'default';
        // Cancel any pending viz:renderer:ready label listener — the renderer
        // that was queued never became (or stayed) active.
        if (_cancelPendingAutoLabel) { _cancelPendingAutoLabel(); _cancelPendingAutoLabel = null; }
        // Clear any Auto-resolved label — the renderer that was advertised
        // never became (or stayed) active.
        _setAutoVizLabel(null);
        try { localStorage.setItem('vizSelection', 'default'); } catch (_) {}
        console.warn(
            `viz picker: reverted to default renderer (${e.detail?.reason || 'unknown'}).`
        );
    });
}

// ── Visualization picker (slopsmith#36) ─────────────────────────────────
//
// Discovers viz plugins via /api/plugins and adds them to the #viz-picker
// dropdown. A viz plugin declares itself by setting `"type": "visualization"`
// in its plugin.json AND exposing a factory function on
// window.slopsmithViz_<id> that returns an object matching the setRenderer
// contract ({init, draw, resize, destroy}).
//
// The "default" option in the dropdown is the built-in 2D highway that
// lives inside createHighway(); selecting it calls setRenderer(null) which
// restores the default renderer. The bundled 3D Highway plugin
// (plugins/highway_3d/) registers as id `highway_3d` and is the new
// fresh-install default per slopsmith#160 PR 3.

// ── WebGL2 detection (one-shot probe) ────────────────────────────────────
// 3D Highway requires WebGL2. On environments where it's unavailable
// (older browsers, some embedded webviews, software-only contexts), we
// silently fall back to the Classic 2D Highway and flash a single toast
// so the user knows why their highway looks different. Cached so we don't
// thrash the GPU with repeat throwaway-canvas creations.
let _webgl2Probe = null;
function _canRun3D() {
    if (_webgl2Probe !== null) return _webgl2Probe;
    try {
        const c = document.createElement('canvas');
        const gl = c.getContext('webgl2');
        _webgl2Probe = !!gl;
        // Lose the context immediately — the probe canvas is never reused.
        if (gl && gl.getExtension) {
            const ext = gl.getExtension('WEBGL_lose_context');
            if (ext && ext.loseContext) ext.loseContext();
        }
    } catch (_) { _webgl2Probe = false; }
    return _webgl2Probe;
}

// ── Migration / nag flags ────────────────────────────────────────────────
// `slopsmith_3d_promoted_v1` is set the first time we auto-flip an existing
// `vizSelection='default'` user to `'highway_3d'`. Persistence ensures we
// don't re-nag on every reload — and ensures the WebGL2 fallback path
// doesn't ping-pong (one fallback toast, not one per page load).
const _3D_PROMOTED_FLAG_KEY = 'slopsmith_3d_promoted_v1';
function _markPromoted() {
    try { localStorage.setItem(_3D_PROMOTED_FLAG_KEY, '1'); } catch (_) {}
}
function _hasPromotedFlag() {
    try { return localStorage.getItem(_3D_PROMOTED_FLAG_KEY) === '1'; }
    catch (_) { return false; }
}

// Pending nag: queued during _populateVizPicker, fired on the first
// `song:ready` (so the toast lands when the user actually opens the
// player, not at page load when they're still in the library).
// `song:ready` is emitted by highway.js via window.slopsmith.emit(), so
// subscribe through the same EventTarget. window.slopsmith is created in
// this same file before _populateVizPicker is reachable, so the global
// is guaranteed to exist by the time this listener registers — but guard
// anyway in case this module is ever loaded standalone for tests.
let _pendingPromotionNag = false;
if (window.slopsmith && typeof window.slopsmith.on === 'function') {
    window.slopsmith.on('song:ready', () => {
        if (!_pendingPromotionNag) return;
        _pendingPromotionNag = false;
        _showPromotionNag();
    });
}

function _showPromotionNag() {
    // Lightweight toast — no dependency on a generic toast helper, since
    // app.js doesn't currently have one. Fixed bottom-center, dismissed
    // by clicking either action button or the × close.
    const existing = document.getElementById('slopsmith-3d-nag');
    if (existing) existing.remove();
    const wrap = document.createElement('div');
    wrap.id = 'slopsmith-3d-nag';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'false');
    wrap.setAttribute('aria-label', '3D Highway upgrade notification');
    wrap.style.cssText = `
        position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
        background: linear-gradient(145deg, #1a1a30 0%, #0d0d18 100%);
        border: 1px solid rgba(64,128,224,0.4);
        border-radius: 12px; padding: 12px 16px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 0 1px rgba(64,128,224,0.15);
        font-size: 13px; color: #e2e8f0; z-index: 10000;
        max-width: 480px; display: flex; align-items: center; gap: 12px;
    `;
    wrap.innerHTML = `
        <span aria-live="polite" style="flex:1;">Your highway was upgraded to <strong>3D</strong>.</span>
        <button type="button" data-act="tour" style="background:rgba(64,128,224,0.25);color:#e2e8f0;border:1px solid rgba(64,128,224,0.5);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;">Try the tour</button>
        <button type="button" data-act="back" style="background:transparent;color:#cbd5e1;border:1px solid rgba(255,255,255,0.1);padding:6px 12px;border-radius:8px;font-size:12px;cursor:pointer;">Switch back to 2D</button>
        <button type="button" data-act="dismiss" aria-label="Dismiss" style="background:transparent;color:#6b7280;border:none;font-size:18px;cursor:pointer;padding:0 4px;line-height:1;">×</button>
    `;
    wrap.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-act]');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'tour') {
            try {
                if (window.slopsmithTour && typeof window.slopsmithTour.start === 'function') {
                    window.slopsmithTour.start('highway_3d');
                }
            } catch (_) {}
        } else if (act === 'back') {
            setViz('default');
        }
        wrap.remove();
    });
    document.body.appendChild(wrap);
}

function _showWebGL2FallbackToast() {
    // One-time fallback notice. Same lightweight DOM as the nag, simpler
    // copy and only a dismiss button.
    if (document.getElementById('slopsmith-3d-fallback')) return;
    const wrap = document.createElement('div');
    wrap.id = 'slopsmith-3d-fallback';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'false');
    wrap.setAttribute('aria-label', 'WebGL2 not available');
    wrap.style.cssText = `
        position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%);
        background: #181830; border: 1px solid rgba(255,180,80,0.4);
        border-radius: 12px; padding: 10px 14px;
        font-size: 12px; color: #e2e8f0; z-index: 10000;
        display: flex; align-items: center; gap: 10px;
    `;
    wrap.innerHTML = `
        <span aria-live="polite">3D Highway needs WebGL2 — falling back to Classic 2D.</span>
        <button type="button" data-act="dismiss" aria-label="Dismiss" style="background:transparent;color:#6b7280;border:none;font-size:16px;cursor:pointer;padding:0 4px;line-height:1;">×</button>
    `;
    wrap.addEventListener('click', (ev) => {
        if (ev.target.closest('button[data-act]')) wrap.remove();
    });
    document.body.appendChild(wrap);
    setTimeout(() => { try { wrap.remove(); } catch (_) {} }, 8000);
}

// The "default" option in the dropdown is the built-in 2D highway that
// lives inside createHighway(); selecting it calls setRenderer(null) which
// restores the default renderer.
async function _populateVizPicker(plugins) {
    const sel = document.getElementById('viz-picker');
    if (!sel) return;
    // Clear any previously-appended plugin options so calling this
    // function more than once (e.g. from DevTools, or a hot-reloaded
    // plugin) doesn't produce duplicates. The built-in "auto" and
    // "default" options are static markup — preserve them.
    const BUILTIN_OPT_VALUES = new Set(['auto', 'default']);
    Array.from(sel.options).forEach(opt => {
        if (!BUILTIN_OPT_VALUES.has(opt.value)) sel.removeChild(opt);
    });
    // Accept a pre-fetched plugins array (normal startup path reuses
    // loadPlugins' fetch). Fall back to our own fetch if called
    // standalone — e.g. from the DevTools console for debugging.
    if (!Array.isArray(plugins)) {
        plugins = [];
        try {
            const resp = await fetch('/api/plugins');
            if (resp.ok) plugins = await resp.json();
        } catch (e) {
            console.warn('viz picker: /api/plugins fetch failed', e);
        }
    }
    const vizPlugins = plugins.filter(p => p && p.type === 'visualization');
    // "default" is reserved for the built-in 2D renderer option and
    // "auto" is reserved for the Auto-mode entry — both already in the
    // <select>. A plugin with either id would collide: the
    // restore-from-localStorage lookup would find the built-in entry,
    // dragging the plugin into never-selected land silently. Fail
    // loudly instead.
    const RESERVED_IDS = new Set(['default', 'auto']);
    for (const p of vizPlugins) {
        if (RESERVED_IDS.has(p.id)) {
            console.error(`viz picker: plugin id '${p.id}' collides with a reserved built-in picker entry ('auto' = Auto mode, 'default' = built-in 2D highway); rename the plugin's id in plugin.json to include it in the picker.`);
            continue;
        }
        // Skip entries where the plugin script hasn't exposed a factory —
        // likely means the script failed to load, or the plugin declared
        // itself as a viz without shipping the factory yet.
        const factoryName = 'slopsmithViz_' + p.id;
        if (typeof window[factoryName] !== 'function') {
            console.warn(`viz picker: plugin '${p.id}' has type=visualization but ${factoryName} is not a function; skipping`);
            continue;
        }
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name || p.id;
        sel.appendChild(opt);
    }
    // Restore previous selection if still available. Direct option
    // scan instead of a CSS-selector lookup so we don't depend on
    // CSS.escape (missing in some test environments / older runtimes)
    // and so a weird saved string (e.g. with a quote) can't throw.
    // localStorage.getItem can itself throw when storage is blocked
    // (private mode, sandboxed iframes, some strict test runners);
    // fall back to null so the startup chain doesn't abort.
    let saved = null;
    try { saved = localStorage.getItem('vizSelection'); }
    catch (e) { console.warn('viz picker: unable to read vizSelection', e); }

    // ── 3D promotion migration (slopsmith#160 PR 3) ──────────────────────
    // Existing users with `vizSelection='default'` (the old built-in 2D
    // highway) are auto-flipped to the bundled 3D Highway exactly once,
    // and a non-modal nag toast offers them "Try the tour" / "Switch
    // back to 2D" the first time they open the player. Users on `auto`
    // are left alone (auto-pick semantics unchanged). Users on a custom
    // viz plugin are left alone. WebGL2 absence falls back via setViz.
    if (saved === 'default' && !_hasPromotedFlag()) {
        const has3D = Array.from(sel.options).some(o => o.value === 'highway_3d');
        if (has3D && _canRun3D()) {
            saved = 'highway_3d';
            try { localStorage.setItem('vizSelection', 'highway_3d'); } catch (_) {}
            _markPromoted();
            _pendingPromotionNag = true;
            // Race guard: if song:ready already fired before _populateVizPicker
            // ran (e.g. a deeplink or a fast-loading song), getSongInfo() will
            // already be non-empty and we'll never receive another song:ready
            // in this session. Show the nag immediately in that case.
            const _si = window.highway && window.highway.getSongInfo();
            if (_si && _si.title) {
                _pendingPromotionNag = false;
                _showPromotionNag();
            }
        } else if (has3D && !_canRun3D()) {
            // 3D registered but WebGL2 absent — promote in name but
            // immediately fall back so we don't ping-pong on every load.
            // Set the flag so we don't try again next reload.
            _markPromoted();
            _showWebGL2FallbackToast();
        }
        // No `highway_3d` option (plugin unloaded?) → leave saved as
        // 'default'. We'll retry the migration once the plugin is back.
    }

    const savedMatches = saved && Array.from(sel.options).some(opt => opt.value === saved);
    if (savedMatches) {
        sel.value = saved;
        // 'default' needs no setViz — the highway already starts with
        // the built-in renderer. 'auto' runs setViz so _autoMatchViz
        // fires, though it's a no-op before the first song_info frame.
        if (saved !== 'default') setViz(saved);
    } else if (saved) {
        // Saved selection references an option that no longer exists —
        // plugin uninstalled since last session, renamed, or the plugin
        // script failed to register its factory this time. Clear the
        // stale value so we don't keep trying the same missing viz on
        // every reload, and fall through to the fresh-install default
        // below.
        try { localStorage.removeItem('vizSelection'); }
        catch (_) { /* storage blocked; ignore */ }
        saved = null;
    }
    if (!saved) {
        // Fresh install (or post-cleanup fallthrough): default to the
        // bundled 3D Highway when available + WebGL2-capable, falling
        // back to Auto otherwise so the arrangement-matching plugins
        // (piano on Keys songs, drums on Drums songs, ...) still take
        // over for non-3D arrangements.
        const has3D = Array.from(sel.options).some(o => o.value === 'highway_3d');
        if (has3D && _canRun3D()) {
            sel.value = 'highway_3d';
            try { localStorage.setItem('vizSelection', 'highway_3d'); } catch (_) {}
            setViz('highway_3d');
        } else {
            sel.value = 'auto';
            try { localStorage.setItem('vizSelection', 'auto'); } catch (_) {}
            if (has3D && !_canRun3D()) { _markPromoted(); _showWebGL2FallbackToast(); }
        }
    }
    // Close a startup race: if playback began before loadPlugins
    // finished, song:ready already fired while the picker had no
    // plugin options — _autoMatchViz saw no candidates and left the
    // default active. Now that plugins are registered, re-evaluate
    // against whatever song is currently loaded (a no-op when no song
    // has been loaded yet, since highway.getSongInfo() returns {}).
    if (sel.value === 'auto') _autoMatchViz();
}

function _tagVizRenderer(renderer, id) {
    if (!renderer || !id) return renderer;
    try {
        if (!renderer.pluginId) renderer.pluginId = id;
        if (!renderer.source) renderer.source = id;
    } catch (_) {}
    return renderer;
}

function _installVizRenderer(renderer, id) {
    highway.setRenderer(_tagVizRenderer(renderer, id));
}

function setViz(id) {
    // Helper: reset the UI and persisted selection to the built-in
    // "default" entry. Called whenever the requested viz can't be
    // applied (missing factory, factory threw, factory returned a
    // non-conforming renderer) so the picker, localStorage, and the
    // highway's active renderer stay in sync.
    const fallbackToDefault = () => {
        try { localStorage.setItem('vizSelection', 'default'); } catch (_) {}
        const sel = document.getElementById('viz-picker');
        if (sel) sel.value = 'default';
        highway.setRenderer(null);
    };

    // When switching away from Auto, reset the closed-state label so the
    // Auto option shows base text the next time the user opens the dropdown.
    // Also cancel any pending viz:renderer:ready listener from the previous
    // Auto match cycle so it can't set a stale label after we've moved on.
    if (id !== 'auto') {
        if (_cancelPendingAutoLabel) { _cancelPendingAutoLabel(); _cancelPendingAutoLabel = null; }
        _setAutoVizLabel(null);
    }

    if (id === 'default' || !id) {
        try { localStorage.setItem('vizSelection', id || 'default'); } catch (_) {}
        const _sel = document.getElementById('viz-picker');
        if (_sel) _sel.value = 'default';
        highway.setRenderer(null);
        return;
    }
    if (id === 'auto') {
        try { localStorage.setItem('vizSelection', 'auto'); } catch (_) {}
        _autoMatchViz();
        return;
    }
    // 3D Highway specifically gates on WebGL2. Any future WebGL viz
    // plugin should declare its own probe — for now the bundled 3D
    // Highway is the only viz with this requirement, so the gate is
    // hardcoded. Falling back to 'default' (Classic 2D) keeps the
    // picker in sync; toast informs the user.
    if (id === 'highway_3d' && !_canRun3D()) {
        console.warn('viz picker: WebGL2 unavailable, falling back to Classic 2D Highway');
        _markPromoted();
        _showWebGL2FallbackToast();
        fallbackToDefault();
        return;
    }
    const factory = window['slopsmithViz_' + id];
    if (typeof factory !== 'function') {
        console.error(`viz picker: factory slopsmithViz_${id} not available`);
        fallbackToDefault();
        return;
    }
    let renderer;
    try { renderer = factory(); }
    catch (e) {
        console.error(`viz picker: factory slopsmithViz_${id} threw`, e);
        fallbackToDefault();
        return;
    }
    // Validate shape — highway.setRenderer will itself fall back to
    // default on a bad renderer, but without this check the UI and
    // localStorage would still advertise the broken selection.
    if (!renderer || typeof renderer.draw !== 'function') {
        console.error(`viz picker: factory slopsmithViz_${id} returned an invalid renderer (missing draw)`);
        fallbackToDefault();
        return;
    }
    // Persist only once we know the renderer is valid.
    try { localStorage.setItem('vizSelection', id); } catch (_) {}
    _installVizRenderer(renderer, id);
}

// Auto mode: evaluate each registered viz factory's static
// `matchesArrangement(songInfo)` predicate and install the first
// matching renderer. No match → fall back to the built-in 2D highway.
//
// vizSelection stays 'auto' across invocations so the next song:ready
// re-evaluates. An explicit picker choice overrides Auto by persisting
// a different vizSelection.
//
// Enumerates viz plugins by walking the picker's own <option> list —
// that's the canonical set built by _populateVizPicker above and keeps
// us from needing a second module-level registry.
// Helper: update the closed-state label of the Auto option to show what was resolved.
// Resets to the base label when called with no argument (at evaluation start).
// _autoVizBaseLabel is captured from the DOM on first call so the reset text
// always matches the initial markup rather than a hardcoded duplicate.
let _autoVizBaseLabel = null;
function _setAutoVizLabel(resolvedText) {
    const opt = document.querySelector('#viz-picker option[value="auto"]');
    if (!opt) return;
    if (_autoVizBaseLabel === null) _autoVizBaseLabel = opt.text;
    opt.text = resolvedText != null ? `Auto \u2192 ${resolvedText}` : _autoVizBaseLabel;
}

// Holds a cleanup function for the pending viz:renderer:ready listener
// registered by _autoMatchViz(). Called at the start of each new evaluation
// to remove any listener left over from the previous match cycle.
let _cancelPendingAutoLabel = null;

function _autoMatchViz() {
    const sel = document.getElementById('viz-picker');
    if (!sel) return;
    // Cancel any pending viz:renderer:ready listener from a previous match
    // cycle. The song may change before the previous renderer's async init
    // settles; we don't want that stale listener to clobber the new label.
    if (_cancelPendingAutoLabel) { _cancelPendingAutoLabel(); _cancelPendingAutoLabel = null; }
    // Reset label at evaluation start so a stale resolved label never persists
    // if the song changes or the picker re-evaluates with a different outcome.
    _setAutoVizLabel(null);
    const songInfo = (typeof highway !== 'undefined' && typeof highway.getSongInfo === 'function')
        ? (highway.getSongInfo() || {}) : {};
    // Only update the label when a real song is loaded. Before the first
    // song_info frame, getSongInfo() returns {} — leaving the reset state
    // ("Auto (match arrangement)") is correct; we haven't evaluated yet.
    const hasSong = Object.keys(songInfo).length > 0;
    // Options are stable in DOM order, which matches what users see in
    // the picker. The underlying order comes from /api/plugins →
    // _populateVizPicker, and /api/plugins reflects the order the
    // plugin loader discovered plugins in — plugins/__init__.py walks
    // `sorted(plugins_base_dir.iterdir())`, i.e. sorted by the on-disk
    // PLUGIN DIRECTORY name (e.g. "slopsmith-plugin-drums" sorts
    // before "slopsmith-plugin-piano"), not by the plugin id declared
    // in plugin.json. Two consequences worth noting:
    //   1. First match wins among registered viz plugins — keep each
    //      plugin's matchesArrangement predicate narrow to avoid
    //      stealing songs from more specialized viz.
    //   2. If you need a strict priority when multiple plugins match
    //      the same song, name the higher-priority plugin's directory
    //      earlier alphabetically. The picker dropdown reveals the
    //      actual tiebreaker at a glance.
    const candidateIds = Array.from(sel.options)
        .map(o => o.value)
        .filter(v => v !== 'auto' && v !== 'default');
    for (const id of candidateIds) {
        const factory = window['slopsmithViz_' + id];
        if (typeof factory !== 'function') continue;
        // If the factory statically declares contextType='webgl2', gate on
        // WebGL2 availability so a match never installs a renderer that'll
        // fail at init. This is the generic version of the old hard-coded
        // highway_3d check — any future WebGL2 viz gets the same protection
        // for free without needing a special-case here.
        const factoryCtxType = typeof factory.contextType === 'string' ? factory.contextType : '2d';
        if (factoryCtxType === 'webgl2' && !_canRun3D()) continue;
        const predicate = factory.matchesArrangement;
        if (typeof predicate !== 'function') continue;
        let matched = false;
        try { matched = !!predicate(songInfo); }
        catch (err) {
            console.error(`viz auto: matchesArrangement for ${id} threw`, err);
            continue;
        }
        if (!matched) continue;
        let renderer;
        try { renderer = factory(); }
        catch (err) {
            console.error(`viz auto: factory slopsmithViz_${id} threw`, err);
            continue;
        }
        if (!renderer || typeof renderer.draw !== 'function') {
            console.error(`viz auto: factory slopsmithViz_${id} returned an invalid renderer (missing draw)`);
            continue;
        }
        // Deliberately NOT persisting id — vizSelection stays 'auto' so
        // the next song:ready re-evaluates against the new arrangement.
        //
        // Register the viz:renderer:ready listener BEFORE setRenderer() so we
        // don't miss the event for sync renderers (no readyPromise), which emit
        // it immediately inside setRenderer(). The _onReady guard still checks
        // sel.value so a sync init failure (viz:reverted → sel.value='default')
        // that fires during setRenderer() is handled correctly — the listener
        // fires but finds sel.value !== 'auto' and skips the label update.
        if (hasSong) {
            const matchedOpt = Array.from(sel.options).find(o => o.value === id);
            const labelText = matchedOpt ? matchedOpt.text : id;
            function _onReady() { if (sel.value === 'auto') _setAutoVizLabel(labelText); }
            window.slopsmith.on('viz:renderer:ready', _onReady, { once: true });
            _cancelPendingAutoLabel = () => window.slopsmith.off('viz:renderer:ready', _onReady);
        }
        _installVizRenderer(renderer, id);
        return;
    }
    // No match — restore the built-in 2D highway. setRenderer(null) is
    // a no-op when the default is already active. If the previous Auto
    // pick was a WebGL renderer, highway.setRenderer() handles the
    // context-type change by replacing the canvas element (cloneNode +
    // replaceWith) so the default 2D renderer's getContext('2d') always
    // succeeds — no canvas-lock limitation here.
    highway.setRenderer(null);
    // Update the label so the user can see Auto resolved to the built-in
    // highway. Read from the DOM rather than hard-coding the name so a
    // future rename of the default entry is automatically reflected.
    if (hasSong) {
        const defaultOpt = Array.from(sel.options).find(o => o.value === 'default');
        _setAutoVizLabel(defaultOpt ? defaultOpt.text : null);
    }
}

function formatTime(s) { return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`; }

// ── A-B Loop ────────────────────────────────────────────────────────────
let loopA = null;
let loopB = null;

function setLoopStart() {
    _setSectionPracticeMode(false, { skipClearLoop: true });
    loopA = _audioTime();
    document.getElementById('btn-loop-a').className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
    updateLoopUI();
}

function setLoopEnd() {
    if (loopA === null) return;
    loopB = _audioTime();
    if (loopB <= loopA) { loopB = null; return; }
    document.getElementById('btn-loop-b').className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
    updateLoopUI();
}

function clearLoop(options) {
    const { emitTransportEvent = true } = options || {};
    _setSectionPracticeMode(false, { skipClearLoop: true });
    // playSong() clears the loop on every song load, so only signal a
    // loop-cleared transport event when a loop was actually active —
    // otherwise every song switch emits a spurious playback:loop-cleared.
    const hadLoop = loopA !== null || loopB !== null;
    loopA = null;
    loopB = null;
    document.getElementById('btn-loop-a').className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
    document.getElementById('btn-loop-b').className = 'px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-300 transition';
    document.getElementById('btn-loop-clear').classList.add('hidden');
    document.getElementById('btn-loop-save').classList.add('hidden');
    document.getElementById('loop-label').textContent = '';
    document.getElementById('saved-loops').value = '';
    _sectionPracticeSelected = -1;
    _updateSectionPracticeHighlight(_audioTime());
    if (hadLoop && emitTransportEvent && typeof window !== 'undefined') {
        window.slopsmith?.playback?.transportEvent?.('loop-cleared', {
            requesterId: 'core.loop',
            reason: 'app loop cleared',
            loop: { enabled: false, state: 'inactive' },
        });
    }
}

// Resync #saved-loops + #btn-loop-delete with the currently-active
// loopA/loopB. Used by both setLoop's success path (so plugin-driven
// loops show up correctly in the dropdown) and loadSavedLoop's
// failure path (so a cancelled selection reverts to the still-active
// loop). Without this sync, deleteSelectedLoop could target a stale
// option that doesn't match the active loop.
function _syncSavedLoopSelection() {
    const sel = document.getElementById('saved-loops');
    const delBtn = document.getElementById('btn-loop-delete');
    if (!sel || !delBtn) return;
    let selected = '';
    if (loopA !== null && loopB !== null) {
        for (const opt of sel.options) {
            if (Number(opt.dataset.start) === loopA && Number(opt.dataset.end) === loopB) {
                selected = opt.value;
                break;
            }
        }
    }
    sel.value = selected;
    delBtn.classList.toggle('hidden', !selected);
}

// Programmatically set both loop endpoints and seek to A. The dropdown
// path (loadSavedLoop) and the plugin-API path (window.slopsmith.setLoop)
// both funnel through here so the UI state stays canonical regardless of
// who triggered the loop.
//
// Returns true if the seek landed at A and the loop is now active;
// returns false if the seek was cancelled by teardown or landed off-target
// (JUCE clamp / HTML5 snap > 50ms from A). On false, loopA/loopB are NOT
// committed and the UI is not painted — the prior loop (if any) stays
// active. Throws on invalid inputs.
async function setLoop(a, b, options) {
    const { emitTransportEvent = true } = options || {};
    const aNum = Number(a);
    const bNum = Number(b);
    if (!Number.isFinite(aNum) || !Number.isFinite(bNum) || bNum <= aNum) {
        throw new Error(`setLoop: requires finite a and b with b > a (got a=${a}, b=${b})`);
    }
    // Don't arm loopA/loopB before the seek lands — the 60Hz tick's wrap
    // detector (`ct >= loopB`) would trigger startCountIn against
    // half-applied state.
    const r = await _audioSeek(aNum, 'loop-set');
    if (!r.completed || Math.abs(r.to - aNum) > 0.05) return false;
    loopA = aNum;
    loopB = bNum;
    document.getElementById('btn-loop-a').className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
    document.getElementById('btn-loop-b').className = 'px-3 py-1.5 bg-green-900/50 rounded-lg text-xs text-green-300 transition';
    updateLoopUI();
    // Sync the saved-loops dropdown so a plugin-driven setLoop call
    // surfaces the matching saved option (and Delete button) — otherwise
    // the dropdown can stay on a stale selection and deleteSelectedLoop
    // would target the wrong record.
    _syncSavedLoopSelection();
    if (emitTransportEvent && typeof window !== 'undefined') {
        window.slopsmith?.playback?.transportEvent?.('loop-set', { requesterId: 'core.loop', loopA, loopB, loop: { startTime: loopA, endTime: loopB, enabled: true, state: 'active' } });
    }
    return true;
}

function updateLoopUI() {
    const label = document.getElementById('loop-label');
    const hasLoop = loopA !== null && loopB !== null;
    if (hasLoop) {
        label.textContent = `${formatTime(loopA)} → ${formatTime(loopB)}`;
        document.getElementById('btn-loop-clear').classList.remove('hidden');
        document.getElementById('btn-loop-save').classList.remove('hidden');
    } else if (loopA !== null) {
        label.textContent = `${formatTime(loopA)} → ?`;
        document.getElementById('btn-loop-clear').classList.add('hidden');
        document.getElementById('btn-loop-save').classList.add('hidden');
    } else {
        label.textContent = '';
    }
    _syncSectionPracticeFromLoop();
}

// ── Section Practice Bar ────────────────────────────────────────────────
// One-click looping over Rocksmith section markers (highway.getSections —
// same array as 3D highway bundle.sections / "Now / Up Next").
// Reuses setLoop() so manual A/B controls and saved loops stay canonical.
let _sectionPracticeRanges = [];
let _sectionPracticeSelected = -1;
let _sectionPracticePlaying = -1;
let _sectionPracticeDurSynced = false;
let _sectionPracticeLogged = false;
let _sectionPracticeHooked = false;
let _sectionPracticeRetryTimer = null;
let _sectionPracticeMode = false;

function _setSectionPracticeMode(on, opts = {}) {
    const next = !!on;
    if (next === _sectionPracticeMode && !opts.force) return;
    _sectionPracticeMode = next;
    const cb = document.getElementById('section-practice-mode');
    if (cb) cb.checked = _sectionPracticeMode;
    const bar = document.getElementById('section-practice-bar');
    if (bar) bar.classList.toggle('section-practice-bar--mode-on', _sectionPracticeMode);
    if (_sectionPracticeMode) {
        console.log('[section-practice] mode on');
    } else {
        console.log('[section-practice] mode off');
        _sectionPracticeSelected = -1;
        _updateSectionPracticeHighlight(_audioTime());
        if (!opts.skipClearLoop && (loopA !== null || loopB !== null)) {
            clearLoop();
        }
    }
}

function onSectionPracticeModeChange() {
    const cb = document.getElementById('section-practice-mode');
    if (!cb) return;
    _setSectionPracticeMode(cb.checked);
}

function _resetSectionPracticeLog() {
    _sectionPracticeLogged = false;
}

function _sectionPracticeHighway() {
    return window.highway || (typeof highway !== 'undefined' ? highway : null);
}

function _sectionPracticeDuration() {
    const d = _audioDuration();
    if (d && Number.isFinite(d) && d > 0) return d;
    const cd = window.slopsmith?.currentSong?.duration;
    return (cd && Number.isFinite(cd) && cd > 0) ? cd : 0;
}

function _sectionPracticeSourceSections() {
    const hw = _sectionPracticeHighway();
    if (!hw || typeof hw.getSections !== 'function') return [];
    const raw = hw.getSections();
    return Array.isArray(raw) ? raw : [];
}

function _sectionPracticeStartTime(s) {
    const t = s.time ?? s.startTime ?? s.start_time ?? s.start;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
}

function _sectionPracticeBaseName(rawName, fallbackIndex) {
    let s = (typeof rawName === 'string' ? rawName : '').trim();
    if (!s) s = `Section ${fallbackIndex + 1}`;
    // Normalise separators and strip common trailing digits like "Chorus 2"
    s = s.replace(/_/g, ' ');
    s = s.replace(/\s*\d+$/u, '');
    const lower = s.toLowerCase();
    const canonical = {
        intro: 'Intro',
        verse: 'Verse',
        chorus: 'Chorus',
        bridge: 'Bridge',
        solo: 'Solo',
        riff: 'Riff',
        outro: 'Outro',
    }[lower];
    if (canonical) return canonical;
    // Fallback: title-case words
    return lower.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ') || `Section ${fallbackIndex + 1}`;
}

function _buildSectionPracticeRanges() {
    const raw = _sectionPracticeSourceSections();
    if (!raw.length) return [];
    const dur = _sectionPracticeDuration();
    const sorted = [...raw].sort((a, b) => _sectionPracticeStartTime(a) - _sectionPracticeStartTime(b));
    // Step 1: collapse consecutive same-name markers into logical groups.
    const groups = [];
    for (let i = 0; i < sorted.length; i++) {
        const start = _sectionPracticeStartTime(sorted[i]);
        if (!Number.isFinite(start)) continue;
        const baseName = _sectionPracticeBaseName(sorted[i].name, groups.length);
        const prev = groups[groups.length - 1];
        if (prev && prev.baseName === baseName) {
            prev.lastIndex = i;
        } else {
            groups.push({ baseName, firstIndex: i, lastIndex: i });
        }
    }
    if (!groups.length) return [];
    // Step 2: assign musician-friendly labels with counters (Verse 1, Verse 2, …).
    const counters = Object.create(null);
    const ranges = [];
    for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const base = g.baseName;
        const count = (counters[base] || 0) + 1;
        counters[base] = count;
        const label = `${base} ${count}`;
        const firstSec = sorted[g.firstIndex];
        const start = _sectionPracticeStartTime(firstSec);
        if (!Number.isFinite(start)) continue;
        let end;
        if (gi + 1 < groups.length) {
            const nextFirst = sorted[groups[gi + 1].firstIndex];
            end = _sectionPracticeStartTime(nextFirst);
        } else {
            end = dur;
        }
        if (!Number.isFinite(end) || end <= start) {
            end = dur > start ? dur : start + 4;
        }
        ranges.push({ name: label, start, end });
    }
    return ranges;
}

function _formatSectionPracticeName(name) {
    return name.replace(/_/g, ' ');
}

function _ensureSectionPracticeDom() {
    let bar = document.getElementById('section-practice-bar');
    if (bar) return bar;
    const controls = document.getElementById('player-controls');
    if (!controls) return null;
    bar = document.createElement('div');
    bar.id = 'section-practice-bar';
    bar.className = 'section-practice-bar section-practice-bar--hidden';
    bar.setAttribute('aria-label', 'Section practice');
    bar.innerHTML = '<div class="section-practice-row">'
        + '<label class="section-practice-mode-wrap" title="Loop the selected section until turned off">'
        + '<input type="checkbox" id="section-practice-mode" onchange="onSectionPracticeModeChange()">'
        + '<span class="section-practice-mode-text">Practice Section</span>'
        + '</label>'
        + '<span class="section-practice-label">Sections:</span>'
        + '<div id="section-practice-scroll" class="section-practice-scroll" role="toolbar"></div>'
        + '</div>';
    controls.insertBefore(bar, controls.firstChild);
    return bar;
}

function _showSectionPracticeBar(bar) {
    bar.classList.remove('section-practice-bar--hidden');
    bar.style.display = 'flex';
}

function _hideSectionPracticeBar() {
    _setSectionPracticeMode(false, { skipClearLoop: true });
    const bar = document.getElementById('section-practice-bar');
    if (bar) {
        bar.classList.add('section-practice-bar--hidden');
        bar.style.display = 'none';
    }
    _sectionPracticeRanges = [];
    _sectionPracticeSelected = -1;
    _sectionPracticePlaying = -1;
    _sectionPracticeDurSynced = false;
    const scroll = document.getElementById('section-practice-scroll');
    if (scroll) scroll.innerHTML = '';
}

function _installSectionPracticeDrawHook() {
    if (_sectionPracticeHooked) return;
    const hw = _sectionPracticeHighway();
    if (!hw || typeof hw.addDrawHook !== 'function') return;
    _sectionPracticeHooked = true;
    hw.addDrawHook(() => {
        if (_sectionPracticeRanges.length > 0) return;
        if (_sectionPracticeSourceSections().length > 0) {
            renderSectionPracticeBar();
        }
    });
}

function _scheduleSectionPracticeRetries() {
    if (_sectionPracticeRetryTimer) clearTimeout(_sectionPracticeRetryTimer);
    const delays = [0, 50, 200, 500, 1200];
    let i = 0;
    const tick = () => {
        renderSectionPracticeBar();
        i += 1;
        if (i < delays.length && _sectionPracticeRanges.length === 0) {
            _sectionPracticeRetryTimer = setTimeout(tick, delays[i]);
        } else {
            _sectionPracticeRetryTimer = null;
        }
    };
    tick();
}

function renderSectionPracticeBar() {
    _installSectionPracticeDrawHook();
    const raw = _sectionPracticeSourceSections();
    if (!_sectionPracticeLogged) {
        console.log(`[section-practice] sections found: ${raw.length}`);
        _sectionPracticeLogged = true;
    }
    _sectionPracticeRanges = _buildSectionPracticeRanges();
    const bar = _ensureSectionPracticeDom();
    const scroll = document.getElementById('section-practice-scroll');
    if (!bar || !scroll) return;
    if (_sectionPracticeRanges.length === 0) {
        _hideSectionPracticeBar();
        return;
    }
    _showSectionPracticeBar(bar);
    scroll.innerHTML = _sectionPracticeRanges.map((r, i) => {
        const label = _formatSectionPracticeName(r.name);
        const tip = `${label} (${formatTime(r.start)}–${formatTime(r.end)})`;
        return `<button type="button" class="section-practice-chip" data-section-idx="${i}" title="${esc(tip)}" onclick="practiceSection(${i})">${esc(label)}</button>`;
    }).join('');
    _syncSectionPracticeFromLoop();
    _updateSectionPracticeHighlight(_audioTime());
}

function _sectionPracticeLoopIndex() {
    if (loopA === null || loopB === null) return -1;
    for (let i = 0; i < _sectionPracticeRanges.length; i++) {
        const r = _sectionPracticeRanges[i];
        if (Math.abs(r.start - loopA) < 0.05 && Math.abs(r.end - loopB) < 0.05) {
            return i;
        }
    }
    return -1;
}

async function practiceSection(index) {
    const r = _sectionPracticeRanges[index];
    if (!r) return;
    const dur = _sectionPracticeDuration();
    const start = Number(r.start);
    let end = Number(r.end);
    if (dur && Number.isFinite(dur) && end > dur) end = dur;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;

    console.log('[section-practice] click', { name: r.name, start, end });
    _cancelCountIn();
    _setSectionPracticeMode(true, { skipClearLoop: true });

    // setLoop() is seek-gated: it returns false when the seek is cancelled
    // during arrangement switches / teardown-gen bumps, or when the backend
    // clock clamps off-target. Retry briefly to land after the transport
    // becomes ready without forking the loop system.
    let ok = false;
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            ok = await setLoop(start, end);
        } catch (err) {
            console.warn('[section-practice] setLoop threw:', err);
            ok = false;
        }
        if (ok) break;
        await new Promise(res => setTimeout(res, 60 + attempt * 90));
    }

    if (ok) {
        _sectionPracticeSelected = index;
        _updateSectionPracticeHighlight(_audioTime());
        console.log('[section-practice] loop set', {
            loopA,
            loopB,
            loopEnabled: (loopA !== null && loopB !== null),
        });
        console.log('[section-practice] count-in requested');
        startCountIn({ immediate: true });
    } else {
        _setSectionPracticeMode(false, { skipClearLoop: true });
        console.log('[section-practice] loop set', { loopA, loopB, loopEnabled: false });
    }
}

function _syncSectionPracticeFromLoop() {
    if (!_sectionPracticeRanges.length) return;
    const match = _sectionPracticeLoopIndex();
    _sectionPracticeSelected = match;
    if (loopA !== null && loopB !== null) {
        if (match >= 0) {
            if (!_sectionPracticeMode) {
                _setSectionPracticeMode(true, { skipClearLoop: true });
            }
        } else if (_sectionPracticeMode) {
            _setSectionPracticeMode(false, { skipClearLoop: true });
        }
    } else if (_sectionPracticeMode) {
        _setSectionPracticeMode(false, { skipClearLoop: true });
    }
    _updateSectionPracticeHighlight(_audioTime());
}

function _sectionPracticeIndexAtTime(t) {
    if (!Number.isFinite(t) || _sectionPracticeRanges.length === 0) return -1;
    for (let i = _sectionPracticeRanges.length - 1; i >= 0; i--) {
        if (t >= _sectionPracticeRanges[i].start) return i;
    }
    return -1;
}

function _updateSectionPracticeHighlight(ct) {
    const scroll = document.getElementById('section-practice-scroll');
    if (!scroll || _sectionPracticeRanges.length === 0) return;
    const playing = _sectionPracticeIndexAtTime(ct);
    const chips = scroll.querySelectorAll('.section-practice-chip');
    chips.forEach((chip, i) => {
        chip.classList.toggle('is-playing', i === playing);
        chip.classList.toggle('is-selected', i === _sectionPracticeSelected);
    });
    if (playing !== _sectionPracticePlaying) {
        _sectionPracticePlaying = playing;
        if (playing >= 0) {
            const active = scroll.querySelector(`[data-section-idx="${playing}"]`);
            active?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
        }
    }
}

function _maybeRefreshSectionPracticeDuration(dur) {
    if (_sectionPracticeDurSynced || !dur || _sectionPracticeRanges.length === 0) return;
    const rebuilt = _buildSectionPracticeRanges();
    if (!rebuilt.length) return;
    const prevEnd = _sectionPracticeRanges[_sectionPracticeRanges.length - 1].end;
    const nextEnd = rebuilt[rebuilt.length - 1].end;
    if (Math.abs(prevEnd - nextEnd) > 0.05) {
        _sectionPracticeDurSynced = true;
        renderSectionPracticeBar();
    } else {
        _sectionPracticeDurSynced = true;
    }
}

// Re-render when section metadata appears (before audio duration is known).
function _ensureSectionPracticeBar() {
    if (_sectionPracticeSourceSections().length === 0) return;
    if (_sectionPracticeRanges.length === 0
        || document.getElementById('section-practice-bar')?.classList.contains('section-practice-bar--hidden')) {
        renderSectionPracticeBar();
    }
}

async function loadSavedLoops() {
    const sel = document.getElementById('saved-loops');
    const delBtn = document.getElementById('btn-loop-delete');
    if (!currentFilename) { sel.classList.add('hidden'); delBtn.classList.add('hidden'); return; }

    const resp = await fetch(`/api/loops?filename=${encodeURIComponent(decodeURIComponent(currentFilename))}`);
    const loops = await resp.json();

    sel.innerHTML = '<option value="">Saved Loops</option>';
    for (const l of loops) {
        sel.innerHTML += `<option value="${l.id}" data-start="${l.start}" data-end="${l.end}">${esc(l.name)} (${formatTime(l.start)}→${formatTime(l.end)})</option>`;
    }
    if (loops.length > 0) {
        sel.classList.remove('hidden');
    } else {
        sel.classList.add('hidden');
    }
    delBtn.classList.add('hidden');
}

async function loadSavedLoop(loopId) {
    const sel = document.getElementById('saved-loops');
    const opt = sel.selectedOptions[0];
    const delBtn = document.getElementById('btn-loop-delete');
    if (!loopId || !opt?.dataset.start) {
        delBtn.classList.add('hidden');
        return;
    }
    let ok = false;
    try {
        // Pass raw strings — setLoop's Number() coercion is stricter than
        // parseFloat (rejects "12abc") so malformed dataset values throw
        // and fall into the catch instead of silently truncating.
        ok = await setLoop(opt.dataset.start, opt.dataset.end);
    } catch (err) {
        // Malformed dataset (server returned bad data): treat the same as
        // a failed seek so the dropdown resyncs and we don't propagate an
        // uncaught rejection out of the onchange handler.
        console.warn('[loadSavedLoop] setLoop threw:', err);
        ok = false;
    }
    if (!ok) {
        // Seek aborted, landed off-target, or input was malformed.
        // Resync the dropdown with the still-active loop so the UI
        // doesn't lie about which loop is loaded.
        _syncSavedLoopSelection();
        return;
    }
    // Success path: setLoop already called _syncSavedLoopSelection,
    // which surfaces the delete button when the new loop matches a
    // saved option (which the dropdown selection guarantees here).
}

async function saveCurrentLoop() {
    if (loopA === null || loopB === null || !currentFilename) return;
    const name = prompt('Loop name:', `Loop`);
    if (name === null) return;
    await fetch('/api/loops', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            filename: decodeURIComponent(currentFilename),
            name: name,
            start: loopA,
            end: loopB,
        }),
    });
    await loadSavedLoops();
    document.getElementById('btn-loop-save').classList.add('hidden');
}

async function deleteSelectedLoop() {
    const sel = document.getElementById('saved-loops');
    const loopId = sel.value;
    if (!loopId) return;
    await fetch(`/api/loops/${loopId}`, { method: 'DELETE' });
    clearLoop();
    await loadSavedLoops();
}

// ── Count-in click sound (Web Audio API) ────────────────────────────────
let _audioCtx = null;
function playClick(high = false) {
    if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.frequency.value = high ? 1200 : 800;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.5, _audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _audioCtx.currentTime + 0.08);
    osc.start(_audioCtx.currentTime);
    osc.stop(_audioCtx.currentTime + 0.08);
}

let _countingIn = false;
let _countOverlay = null;
// Generation token so teardown can cancel an in-progress count-in. Each
// startCountIn() captures the gen at entry; rewindStep, the loop-wrap
// then-callback, and beginCount's tick all bail when their captured gen
// no longer matches. Bumped by _cancelCountIn().
let _countInGen = 0;
let _countInTimer = null;
let _countInRaf = 0;
function _cancelCountIn() {
    _countInGen++;
    _countingIn = false;
    hideCountOverlay();
    if (_countInTimer) { clearTimeout(_countInTimer); _countInTimer = null; }
    if (_countInRaf) { cancelAnimationFrame(_countInRaf); _countInRaf = 0; }
}

function showCountOverlay(n) {
    if (!_countOverlay) {
        _countOverlay = document.createElement('div');
        _countOverlay.className = 'fixed inset-0 z-[100] flex items-center justify-center pointer-events-none';
        document.body.appendChild(_countOverlay);
    }
    _countOverlay.innerHTML = `<span class="text-9xl font-black text-white/30">${n}</span>`;
}

function hideCountOverlay() {
    if (_countOverlay) { _countOverlay.remove(); _countOverlay = null; }
}

async function startCountIn(opts = {}) {
    if (_countingIn) return;
    _countingIn = true;
    const immediate = !!opts.immediate;
    // Snapshot the current gen so every delayed callback (rewind frames,
    // post-seek then, count-in ticks, post-count play) can bail if a
    // teardown bumped the gen mid-flight via _cancelCountIn().
    const gen = _countInGen;

    function beginCount() {
        const bpm = highway.getBPM(loopA);
        const beatInterval = 60 / bpm;
        let count = 0;

        function tick() {
            if (gen !== _countInGen) return; // teardown mid-count
            count++;
            if (count > 4) {
                hideCountOverlay();
                _countingIn = false;
                if (window._juceMode) {
                    jucePlayer.play().then((started) => {
                        if (gen !== _countInGen) return; // teardown during play start
                        if (!started) return;
                        isPlaying = true;
                        setPlayButtonState(true);
                        window.slopsmith.isPlaying = true;
                        const payload = _songEventPayload();
                        window.slopsmith.emit('song:play', payload);
                        window.slopsmith.emit('song:resume', payload);
                    }).catch((err) => console.error('[app] jucePlayer.play error:', err));
                } else if (audio.src && audio.src !== window.location.href) {
                    audio.play().then(() => {
                        if (gen !== _countInGen) return;
                        isPlaying = true;
                        setPlayButtonState(true);
                    }).catch((err) => {
                        if (gen !== _countInGen) return;
                        console.error('[app] audio.play() rejected after count-in:', err);
                        isPlaying = false;
                        setPlayButtonState(false);
                    });
                }
                return;
            }
            showCountOverlay(count);
            playClick(count === 1);
            _countInTimer = setTimeout(tick, beatInterval * 1000);
        }
        _countInTimer = setTimeout(tick, 500);
    }

    if (window._juceMode) {
        await jucePlayer.pause().catch((err) => console.error('[app] jucePlayer.pause error in count-in:', err));
    } else {
        audio.pause();
    }
    if (gen !== _countInGen) return; // teardown during pause

    // Section-practice entry: already at loop A after setLoop(); skip the
    // B→A rewind animation used on loop wrap and go straight to clicks.
    if (immediate) {
        if (loopA === null || loopB === null) {
            _countingIn = false;
            return;
        }
        lastAudioTime = loopA;
        highway.setTime(loopA);
        if (window.slopsmith) {
            window.slopsmith.emit('loop:restart', { loopA, loopB, time: loopA });
        }
        beginCount();
        return;
    }

    // Rewind animation: sweep highway time from B to A
    const rewindDuration = 400; // ms
    const rewindStart = performance.now();
    const fromTime = loopB;
    const toTime = loopA;

    function rewindStep(now) {
        if (gen !== _countInGen) return; // teardown mid-rewind
        const elapsed = now - rewindStart;
        const t = Math.min(elapsed / rewindDuration, 1);
        // Ease out quad
        const eased = 1 - (1 - t) * (1 - t);
        const currentT = fromTime + (toTime - fromTime) * eased;
        highway.setTime(currentT);
        if (t < 1) {
            _countInRaf = requestAnimationFrame(rewindStep);
        } else {
            _countInRaf = 0;
            // Rewind done — set final position and start count.
            // Await the JUCE seek so the engine has repositioned before
            // we start the click track (HTML5 path is synchronous).
            _audioSeek(loopA, 'loop-wrap').then((r) => {
                if (gen !== _countInGen) return; // teardown during seek
                // Abort the loop restart in two cases:
                //   1. Cancelled (player torn down): don't beginCount on a
                //      new session.
                //   2. Off-target landing (JUCE rollback / clamp far from
                //      loopA): proceeding would emit loop:restart and start
                //      a count-in from the wrong position. Audio is at
                //      r.from / r.to, which is not where the loop wants to
                //      resume — better to drop this iteration than play out
                //      of sync.
                // 50 ms tolerance: well within JUCE's normal seek precision
                // but tight enough to catch a real rollback or no-op.
                if (!r.completed || Math.abs(r.to - loopA) > 0.05) {
                    // startCountIn paused audio at entry but left isPlaying
                    // alone — beginCount would have set it on resume. On
                    // abort, sync the transport: audio is paused, so
                    // isPlaying must reflect that and the button + plugin
                    // host must agree.
                    _countingIn = false;
                    if (isPlaying) {
                        isPlaying = false;
                        setPlayButtonState(false);
                        if (window.slopsmith) {
                            window.slopsmith.isPlaying = false;
                            window.slopsmith.emit('song:pause', _songEventPayload());
                        }
                    }
                    return;
                }
                // Use the verified post-seek clock for the chart so audio
                // and chart stay in sync if JUCE clamped to slightly
                // before/after loopA. The loop:restart event keeps `time:
                // loopA` because subscribers treat that as the semantic
                // marker for "new iteration starts at A", not the actual
                // audio position.
                lastAudioTime = r.to;
                highway.setTime(r.to);
                window.slopsmith.emit('loop:restart', { loopA, loopB, time: loopA });
                beginCount();
            });
        }
    }
    _countInRaf = requestAnimationFrame(rewindStep);
}

// Time display + highway sync
let lastAudioTime = 0;
setInterval(() => {
    let ct = _audioTime();
    const dur = _audioDuration();
    if (dur && !_countingIn) {
        // JUCE end-of-track: HTML5 fires 'ended'; JUCE needs a manual check
        if (window._juceMode && isPlaying && ct >= dur) {
            isPlaying = false;
            setPlayButtonState(false);
            window.slopsmith.isPlaying = false;
            window.slopsmith.emit('song:ended', _songEventPayload());
            jucePlayer.pause().catch((err) => console.warn('[app] end-of-track pause error:', err));
        }
        // A-B loop: count-in then seek back to A
        else if (loopA !== null && loopB !== null && ct >= loopB) {
            lastAudioTime = loopB;
            startCountIn();
        }
        // Detect and fix audio time jumps (browser seeking bug; skip for JUCE — position is polled)
        else if (!window._juceMode && isPlaying && Math.abs(ct - lastAudioTime) > 30 && lastAudioTime > 0) {
            console.warn(`Audio time jumped from ${lastAudioTime.toFixed(1)} to ${ct.toFixed(1)}, resetting`);
            _audioSeek(lastAudioTime, 'jump-fix');
            // Treat the corrected position as canonical for the rest of this
            // tick. Otherwise we'd write the stale jumped `ct` into
            // lastAudioTime below and ping-pong on the next tick.
            ct = lastAudioTime;
        }
        lastAudioTime = ct;
        document.getElementById('hud-time').textContent = `${formatTime(ct)} / ${formatTime(dur)}`;
        if (dur) {
            _maybeRefreshSectionPracticeDuration(dur);
        }
    }
    _ensureSectionPracticeBar();
    if (_sectionPracticeRanges.length) {
        _updateSectionPracticeHighlight(ct);
    }
    if (!_countingIn) highway.setTime(ct);
}, 1000 / 60);

_installSectionPracticeDrawHook();

// ── Centralized Keyboard Shortcut Registry ───────────────────────────────
//
// Plugins can register keyboard shortcuts via window.registerShortcut().
// Shortcuts are scope-aware (global, player, library, plugin-specific) and
// support optional condition callbacks for dynamic enable/disable.
//
// Panel-scoped shortcuts:
//   - Each panel has its own shortcut registry
//   - Use window.createShortcutPanel(id) to create a panel
//   - Use window.setActiveShortcutPanel(id) to set the active panel
//   - Shortcuts are registered to the active panel
//   - This allows multiple panels (e.g., splitscreen) to have their own shortcuts
//
// API:
//   window.registerShortcut({
//     key: string,              // Required: key value (e.key) or key code (e.code)
//     description: string,     // Required: shown in help panel
//     scope: 'global' | 'player' | 'library' | 'settings' | 'plugin-{id}',  // Default: 'global'
//     condition: () => boolean,  // Optional: dynamic enable/disable guard
//     handler: (e) => void,    // Required: callback when shortcut triggers
//     modifiers: {              // Optional: require modifier keys
//       ctrl?: boolean,
//       alt?: boolean,
//       shift?: boolean,
//       meta?: boolean
//     }
//   });
//
// Panel API:
//   window.createShortcutPanel(id) - Create a new panel
//   window.setActiveShortcutPanel(id) - Set the active panel for registration
//   window.getActiveShortcutPanel() - Get the current active panel
//   window.isInShortcutPanel() - Check if running in a panel (not default)
//   window.getGlobalShortcutContext() - Get default panel for truly global shortcuts
//
// Note: The handler receives the KeyboardEvent, so you can check
// e.shiftKey, e.altKey, etc. directly in your handler if you need
// behavior that depends on modifier state (e.g., different actions
// for Shift+key vs key alone). Use the modifiers option when you
// want the shortcut to ONLY fire with specific modifiers.
//
// See CLAUDE.md for full documentation.

// ── Window ID system for per-window shortcuts ────────────────────────────────
// Each window gets a unique ID so plugins can register window-specific shortcuts.
// This is useful for popup windows (e.g., splitscreen plugin) that need their
// own keyboard shortcuts.

let _shortcutWindowId = null;

window.getShortcutWindowId = () => {
    if (_shortcutWindowId) return _shortcutWindowId;
    // Generate a unique ID for this window
    _shortcutWindowId = 'win-' + Math.random().toString(36).substr(2, 9);
    return _shortcutWindowId;
};

// ── Shortcut registry ───────────────────────────────────────────────────────

// ── Panel-scoped shortcut system ───────────────────────────────────────────
// Each panel has its own shortcut registry. This allows multiple panels
// (e.g., splitscreen) to have their own keyboard shortcuts without collisions.

class ShortcutPanel {
    constructor(id) {
        this.id = id;
        this.shortcuts = new Map();
    }
    
    _compositeKey(key, scope) {
        return `${scope}::${key}`;
    }
    
    registerShortcut(options) {
        const { key, description, scope = 'global', condition = null, handler, modifiers = null } = options;
        
        if (!key || !handler) {
            console.error(`registerShortcut: key and handler are required`);
            return;
        }
        
        // Validate scope
        const validScopes = ['global', 'player', 'library', 'settings'];
        const isValidScope = validScopes.includes(scope) || 
                             scope.startsWith('plugin-');
        if (!isValidScope) {
            console.warn(`registerShortcut: invalid scope '${scope}'. Valid scopes are: global, player, library, settings, or plugin-{id}`);
        }
        
        // Conflict detection: warn if key+scope is already registered
        const compositeKey = this._compositeKey(key, scope);
        if (this.shortcuts.has(compositeKey)) {
            console.warn(`registerShortcut [${this.id}]: '${key}' in scope '${scope}' is already registered; overwriting. Previous:`, this.shortcuts.get(compositeKey));
        }
        
        this.shortcuts.set(compositeKey, { key, description, scope, condition, handler, modifiers });
    }
    
    unregisterShortcut(key, scope) {
        return this.shortcuts.delete(this._compositeKey(key, scope));
    }
    
    clearShortcuts() {
        this.shortcuts.clear();
    }
    
    listShortcuts() {
        return Array.from(this.shortcuts.entries()).map(([ck, s]) => [s.key, s]);
    }
}

// Global panel management
const _panels = new Map();
let _activePanel = null;
let _defaultPanel = null;

// Create default panel on init
const defaultPanel = new ShortcutPanel('default');
_panels.set('default', defaultPanel);
_defaultPanel = 'default';
_activePanel = 'default';

// ── Panel API ───────────────────────────────────────────────────────────────

window.createShortcutPanel = (id) => {
    if (_panels.has(id)) {
        console.warn(`createShortcutPanel: panel '${id}' already exists`);
        return _panels.get(id);
    }
    const panel = new ShortcutPanel(id);
    _panels.set(id, panel);
    return panel;
};

window.setActiveShortcutPanel = (id) => {
    if (!_panels.has(id)) {
        console.error(`setActiveShortcutPanel: panel '${id}' does not exist`);
        return;
    }
    _activePanel = id;
};

window.getActiveShortcutPanel = () => _activePanel;

window.isInShortcutPanel = () => {
    return _activePanel !== 'default';
};

window.getGlobalShortcutContext = () => {
    console.warn('getGlobalShortcutContext: Global shortcuts are exceptional. Consider using panel-scoped shortcuts instead.');
    return _panels.get('default');
};

// ── Shortcut registry (routes to active panel) ───────────────────────────────

window.registerShortcut = (options) => {
    const panelId = _activePanel || _defaultPanel || 'default';
    const panel = _panels.get(panelId);
    
    if (!panel) {
        console.error(`registerShortcut: No panel found for registration: ${panelId}`);
        return;
    }
    
    panel.registerShortcut(options);
};

window.unregisterShortcut = (key, scope) => {
    // Try the active panel first to preserve panel isolation; fall back to
    // other panels so a shortcut registered before a panel switch is still
    // removable.
    const resolvedScope = scope || 'global';
    const activePanelId = _activePanel || _defaultPanel || 'default';
    const activePanel = _panels.get(activePanelId);
    if (activePanel && activePanel.unregisterShortcut(key, resolvedScope)) {
        return true;
    }
    for (const [panelId, panel] of _panels) {
        if (panelId === activePanelId) continue;
        if (panel.unregisterShortcut(key, resolvedScope)) {
            return true;
        }
    }
    return false;
};

window.clearWindowShortcuts = (windowId) => {
    // Remove all shortcuts registered for a specific window
    // This is for backward compatibility with window-specific shortcuts
    let removed = 0;
    for (const [panelId, panel] of _panels) {
        if (panelId.startsWith(`window-${windowId}`)) {
            panel.clearShortcuts();
            _panels.delete(panelId);
            removed++;
        }
    }
    return removed;
};

function _getCurrentContext() {
    const currentScreen = document.querySelector('.screen.active')?.id;
    return {
        screen: currentScreen,
        windowId: window.getShortcutWindowId(),
        activePanel: _activePanel,
        isPlayer: currentScreen === 'player',
        isLibrary: ['home', 'favorites'].includes(currentScreen),
        isSettings: currentScreen === 'settings',
        isPlugin: currentScreen?.startsWith('plugin-')
    };
}

function _isShortcutActive(shortcut, ctx) {
    if (shortcut.scope === 'global') return true;
    if (shortcut.scope === 'player' && ctx.isPlayer) return true;
    if (shortcut.scope === 'library' && ctx.isLibrary) return true;
    if (shortcut.scope === 'settings' && ctx.isSettings) return true;
    if (shortcut.scope.startsWith('plugin-')) {
        const pluginId = shortcut.scope.replace('plugin-', '');
        return ctx.screen === `plugin-${pluginId}`;
    }
    return false;
}

function _modifiersMatch(e, modifiers) {
    if (!modifiers) return true;
    if (modifiers.ctrl !== undefined && modifiers.ctrl !== e.ctrlKey) return false;
    if (modifiers.alt !== undefined && modifiers.alt !== e.altKey) return false;
    if (modifiers.shift !== undefined && modifiers.shift !== e.shiftKey) return false;
    if (modifiers.meta !== undefined && modifiers.meta !== e.metaKey) return false;
    return true;
}

// Debug mode for keyboard shortcuts
let _DEBUG_SHORTCUTS = false;

window._setDebugShortcuts = (enabled) => {
    _DEBUG_SHORTCUTS = enabled;
    console.log(`[Shortcuts] Debug mode ${enabled ? 'ENABLED' : 'DISABLED'}`);
};

window._listShortcuts = () => {
    console.log('=== Registered Shortcuts ===');
    for (const [panelId, panel] of _panels) {
        console.log(`Panel: ${panelId}`);
        for (const [, s] of panel.shortcuts) {
            console.log(`  ${s.key.padEnd(15)} | ${s.scope.padEnd(10)} | ${s.description}`);
        }
    }
    console.log('=== End ===');
};

window._testShortcut = (key, scope) => {
    // Mirror the dispatcher: try the active panel first, then default.
    const resolvedScope = scope || 'global';
    const tried = new Set();
    const panelOrder = [_activePanel, _defaultPanel, 'default'].filter(id => {
        if (!id || tried.has(id)) return false;
        tried.add(id);
        return true;
    });

    for (const panelId of panelOrder) {
        const panel = _panels.get(panelId);
        if (!panel) continue;
        const shortcut = panel.shortcuts.get(panel._compositeKey(key, resolvedScope));
        if (!shortcut) continue;

        const ctx = _getCurrentContext();
        const active = _isShortcutActive(shortcut, ctx);
        let conditionMet = true;
        if (shortcut.condition) {
            try { conditionMet = !!shortcut.condition(); }
            catch (err) { conditionMet = `threw: ${err.message}`; }
        }
        console.log(`Shortcut '${key}' [${resolvedScope}] [${panelId}]:`, {
            description: shortcut.description,
            scope: shortcut.scope,
            currentContext: ctx,
            isActive: active,
            conditionMet
        });
        return;
    }

    console.log(`Shortcut '${key}' (scope: ${resolvedScope}) not registered in any panel`);
};

// Expose internals for debugging (prefixed with _ to indicate private)
// These are for development/debugging only and should not be used by plugins.
window._panels = _panels;
window._getCurrentContext = _getCurrentContext;
window._isShortcutActive = _isShortcutActive;

// ── Registry-based keydown handler ─────────────────────────────────────────
//
// This handler processes all registered shortcuts through the central registry.
// It runs after the library navigation handler (which handles /, ?, c, f, e, etc.)
// and before any other keydown listeners.

document.addEventListener('keydown', e => {
    // Don't intercept if typing in an input field
    if (_isTextInput(e.target) || _isInsideInteractiveControl(e.target)) return;

    const ctx = _getCurrentContext();
    const activePanel = _panels.get(_activePanel);
    const defaultPanel = _panels.get('default');
    
    if (!activePanel && !defaultPanel) return;

    if (_DEBUG_SHORTCUTS) {
        console.log('[Shortcuts] Key pressed:', { key: e.key, code: e.code, ctx, activePanel: _activePanel });
    }

    // Try active panel first, then fall back to default
    const panelsToDispatch = [];
    if (activePanel && activePanel !== defaultPanel) panelsToDispatch.push(activePanel);
    if (defaultPanel) panelsToDispatch.push(defaultPanel);

    for (const panel of panelsToDispatch) {
        for (const [, shortcut] of panel.shortcuts) {
        // Match on both e.key (character produced) and e.code (physical key)
        if (e.key !== shortcut.key && e.code !== shortcut.key) continue;

        // Check modifier keys if specified
        if (!_modifiersMatch(e, shortcut.modifiers)) continue;

        if (_DEBUG_SHORTCUTS) {
            console.log('[Shortcuts] Matched shortcut:', shortcut.key, shortcut);
        }

        // Check scope
        if (!_isShortcutActive(shortcut, ctx)) {
            if (_DEBUG_SHORTCUTS) {
                console.log('[Shortcuts] Not active - scope mismatch:', shortcut.scope, ctx);
            }
            continue;
        }

        // Check condition callback — guard against plugin errors
        if (shortcut.condition) {
            try {
                if (!shortcut.condition()) {
                    if (_DEBUG_SHORTCUTS) {
                        console.log('[Shortcuts] Not active - condition failed');
                    }
                    continue;
                }
            } catch (err) {
                console.error('[Shortcuts] condition() threw for key:', shortcut.key, err);
                continue;
            }
        }

        e.preventDefault();
        if (_DEBUG_SHORTCUTS) {
            console.log('[Shortcuts] Executing handler for:', shortcut.key);
        }
        // Guard handler against plugin errors
        try {
            shortcut.handler(e);
        } catch (err) {
            console.error('[Shortcuts] handler() threw for key:', shortcut.key, err);
        }
        return;
    }
}

    if (_DEBUG_SHORTCUTS) {
        console.log('[Shortcuts] No shortcut matched for:', e.key, e.code);
    }
});

// ── Window cleanup ───────────────────────────────────────────────────────────
// Clean up window-specific shortcuts when a window is closed.
// This is important for popup windows (e.g., splitscreen plugin) that
// may be closed by the user.

window.addEventListener('beforeunload', () => {
    const windowId = window.getShortcutWindowId();
    const removed = window.clearWindowShortcuts(windowId);
    if (removed > 0 && _DEBUG_SHORTCUTS) {
        console.log(`[Shortcuts] Cleaned up ${removed} shortcuts for window ${windowId}`);
    }
});

// ── Register built-in shortcuts ───────────────────────────────────────────

// Global shortcuts
registerShortcut({
    key: '?',
    description: 'Show keyboard shortcuts',
    scope: 'global',
    handler: () => _openShortcutsModal()
});

// Library shortcuts
registerShortcut({
    key: '/',
    description: 'Focus search',
    scope: 'library',
    handler: () => {
        const input = _activeSearchInput();
        if (input) input.focus();
    }
});

registerShortcut({
    key: 'c',
    description: 'Convert PSARC entry to .sloppak',
    scope: 'library',
    handler: () => {
        // Handled by library navigation - this is for documentation only
    }
});

registerShortcut({
    key: 'f',
    description: 'Toggle favorite',
    scope: 'library',
    handler: () => {
        // Handled by library navigation - this is for documentation only
    }
});

registerShortcut({
    key: 'e',
    description: 'Edit metadata',
    scope: 'library',
    handler: () => {
        // Handled by library navigation - this is for documentation only
    }
});

// Player shortcuts
registerShortcut({
    key: 'Space',
    description: 'Play/Pause',
    scope: 'player',
    handler: () => togglePlay()
});

registerShortcut({
    key: 'ArrowLeft',
    description: 'Seek back 5 seconds',
    scope: 'player',
    handler: () => seekBy(-5)
});

registerShortcut({
    key: 'ArrowRight',
    description: 'Seek forward 5 seconds',
    scope: 'player',
    handler: () => seekBy(5)
});

registerShortcut({
    key: 'Escape',
    description: 'Back to library',
    scope: 'player',
    handler: () => showScreen(_playerOriginScreen || 'home')
});

registerShortcut({
    key: 'Escape',
    description: 'Go back to previous screen',
    scope: 'settings',
    handler: () => showScreen(_settingsOriginScreen || 'home')
});

registerShortcut({
    key: '[',
    description: 'Offset audio back (Shift: 50ms, else 10ms)',
    scope: 'player',
    handler: (e) => nudgeAvOffsetMs(e.shiftKey ? -50 : -10)
});

registerShortcut({
    key: ']',
    description: 'Offset audio forward (Shift: 50ms, else 10ms)',
    scope: 'player',
    handler: (e) => nudgeAvOffsetMs(e.shiftKey ? 50 : 10)
});

registerShortcut({
    key: '+',
    description: 'Volume up',
    scope: 'player',
    modifiers: { ctrl: false, alt: false, meta: false },
    handler: () => _adjustSongVolume(1)
});

// Layout-portable alias — matches the physical "=/+" key (e.code === 'Equal')
// regardless of keyboard layout or shift state, so non-US layouts that
// don't map Shift+= to '+' still work.
registerShortcut({
    key: 'Equal',
    description: 'Volume up',
    scope: 'player',
    modifiers: { ctrl: false, alt: false, meta: false },
    handler: () => _adjustSongVolume(1)
});

registerShortcut({
    key: '-',
    description: 'Volume down',
    scope: 'player',
    modifiers: { ctrl: false, alt: false, meta: false },
    handler: () => _adjustSongVolume(-1)
});

registerShortcut({
    key: 'Minus',
    description: 'Volume down',
    scope: 'player',
    modifiers: { ctrl: false, alt: false, meta: false },
    handler: () => _adjustSongVolume(-1)
});

// ── Edit metadata modal ─────────────────────────────────────────────────
function openEditModal(songData, openerEl) {
    const artUrl = `/api/song/${encodeURIComponent(songData.f)}/art?t=${Date.now()}`;
    const modal = document.createElement('div');
    modal.id = 'edit-modal';
    modal.className = 'slopsmith-modal fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm';
    // role=dialog: assistive tech announces it as a modal; also lets
    // the global keyboard listener's `_isInsideInteractiveControl`
    // bail when typing inside the modal so Library shortcuts don't
    // hijack keys from the edit form.
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Edit song metadata');
    // Record the element that triggered the modal so Esc / Cancel can
    // return focus to the exact entry the user was on, even if
    // _lastLibSelected changes before the modal closes.
    // Prefer the explicitly-passed openerEl (from the edit-btn click
    // handler, which has the exact [data-play] parent) over
    // _lastLibSelected, which may not have been updated when the
    // click's stopPropagation() prevented the card-click handler.
    const _emActive = document.querySelector('.screen.active');
    const _emLast = (_lastLibSelected && document.body.contains(_lastLibSelected)
        && _emActive && _emActive.contains(_lastLibSelected)) ? _lastLibSelected : null;
    modal._opener = (openerEl && document.body.contains(openerEl)) ? openerEl : _emLast;
    modal.innerHTML = `
        <div class="bg-dark-700 border border-gray-700 rounded-2xl p-6 w-full max-w-md mx-4 shadow-2xl">
            <h3 class="text-lg font-bold text-white mb-4">Edit Song</h3>
            <div class="space-y-3">
                <div class="flex items-center gap-4 mb-2">
                    <div class="relative group cursor-pointer" id="edit-art-wrapper">
                        <img src="${artUrl}" alt="" class="w-20 h-20 rounded-lg object-cover bg-dark-600" id="edit-art-preview">
                        <div class="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition">
                            <span class="text-white text-xs">Change</span>
                        </div>
                        <input type="file" accept="image/*" id="edit-art-file" class="hidden" onchange="previewEditArt(this)">
                    </div>
                    <p class="text-xs text-gray-500 flex-1">Click image to change album art</p>
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Title</label>
                    <input type="text" id="edit-title" value="${_escAttr(songData.t)}"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Artist</label>
                    <input type="text" id="edit-artist" value="${_escAttr(songData.a)}"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
                <div>
                    <label class="text-xs text-gray-400 mb-1 block">Album</label>
                    <input type="text" id="edit-album" value="${_escAttr(songData.al)}"
                        class="w-full bg-dark-600 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-200 outline-none focus:border-accent/50">
                </div>
            </div>
            <div class="flex gap-3 mt-5">
                <button onclick="saveEditModal('${encodeURIComponent(songData.f)}')"
                    class="flex-1 bg-accent hover:bg-accent-light px-4 py-2 rounded-xl text-sm font-semibold text-white transition">Save</button>
                <button data-edit-close
                    class="px-4 py-2 bg-dark-600 hover:bg-dark-500 rounded-xl text-sm text-gray-300 transition">Cancel</button>
            </div>
            <div class="mt-4 pt-4 border-t border-gray-800">
                <button data-delete-filename="${_escAttr(songData.f)}"
                    class="w-full px-4 py-2 bg-red-900/30 hover:bg-red-900/60 border border-red-900/50 hover:border-red-700 rounded-xl text-sm text-red-300 hover:text-red-100 transition">Remove from library</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    // Move focus into the dialog's first text input so background
    // shortcuts (and arrow nav) can't fire on the underlying library
    // entry while the edit form is open. Title is the natural primary
    // field — most edits are correcting spelling there. Caret-end
    // selection so the user can keep typing rather than overtype the
    // current value.
    const titleInput = document.getElementById('edit-title');
    if (titleInput) {
        titleInput.focus({ preventScroll: true });
        try {
            const len = titleInput.value.length;
            titleInput.setSelectionRange(len, len);
        } catch { /* some browsers reject selection on certain input types */ }
    }

    // Trap Tab / Shift+Tab inside the modal so focus can't escape to
    // the library content underneath while the edit form is open.
    _trapFocusInModal(modal);

    // Click on art triggers file input
    document.getElementById('edit-art-wrapper').addEventListener('click', () => {
        document.getElementById('edit-art-file').click();
    });

    const deleteBtn = modal.querySelector('[data-delete-filename]');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', () => {
            deleteSongFromModal(deleteBtn.dataset.deleteFilename);
        });
    }

    // Close on backdrop click or Cancel button; restore focus to opener.
    modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.closest('[data-edit-close]')) {
            const opener = modal._opener;
            modal.remove();
            const focusTarget = (opener && document.body.contains(opener)) ? opener
                : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
            if (focusTarget) focusTarget.focus({ preventScroll: true });
        }
    });
}

function previewEditArt(input) {
    if (!input.files || !input.files[0]) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        document.getElementById('edit-art-preview').src = e.target.result;
    };
    reader.readAsDataURL(input.files[0]);
}

async function saveEditModal(encodedFilename) {
    const filename = decodeURIComponent(encodedFilename);

    // Save metadata
    await fetch(`/api/song/${encodeURIComponent(filename)}/meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: document.getElementById('edit-title').value.trim(),
            artist: document.getElementById('edit-artist').value.trim(),
            album: document.getElementById('edit-album').value.trim(),
        }),
    });

    // Upload art if changed
    const fileInput = document.getElementById('edit-art-file');
    if (fileInput.files && fileInput.files[0]) {
        const reader = new FileReader();
        reader.onload = async (e) => {
            await fetch(`/api/song/${encodeURIComponent(filename)}/art/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: e.target.result }),
            });
        };
        reader.readAsDataURL(fileInput.files[0]);
    }

    const modal = document.getElementById('edit-modal');
    const opener = modal ? modal._opener : null;
    if (modal) modal.remove();
    // Restore focus to the entry the modal was opened from so subsequent
    // keyboard navigation resumes correctly (same as Esc / Cancel paths).
    const focusTarget = (opener && document.body.contains(opener)) ? opener
        : (_lastLibSelected && document.body.contains(_lastLibSelected) ? _lastLibSelected : null);
    if (focusTarget) focusTarget.focus({ preventScroll: true });
    // Refresh current view
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen?.id === 'favorites') loadFavorites();
    else loadLibrary();
}

async function deleteSongFromModal(filename) {
    const title = (document.getElementById('edit-title')?.value || filename).trim();
    const ok = await _confirmDialog({
        title: 'Remove from library?',
        body: `<p class="text-sm text-gray-300">Remove <span class="font-semibold text-white">${_escAttr(title)}</span> from your library?</p>
               <p class="text-xs text-red-400/90 mt-2">This permanently deletes the file from disk. This cannot be undone.</p>`,
        confirmText: 'Remove',
        cancelText: 'Cancel',
        danger: true,
    });
    if (!ok) return;
    let resp;
    try {
        resp = await fetch(`/api/song/${encodeURIComponent(filename)}`, { method: 'DELETE' });
    } catch (e) {
        alert(`Delete failed: ${e.message}`);
        return;
    }
    if (!resp.ok) {
        let msg = resp.statusText;
        try { msg = (await resp.json()).error || msg; } catch (_) {}
        alert(`Delete failed: ${msg}`);
        return;
    }
    const modal = document.getElementById('edit-modal');
    if (modal) modal.remove();
    _treeStats = null;
    _favTreeStats = null;
    _tuningNames = null;

    // Remove the deleted song's card from any currently-rendered grid/tree
    // so the user sees it disappear without waiting for a refetch. A full
    // loadLibrary() here would re-call loadGridPage(currentPage), which
    // uses 'append' mode when currentPage > 0 and re-appends the same
    // (now-shortened) page on top of what's already rendered — leaving
    // the deleted card visible. Direct DOM removal also preserves scroll
    // position, which a refetch from page 0 would lose.
    _removeLibCardsForFilename(filename);

    // Tree views group by artist with song counts; a single card removal
    // leaves stale counts, so refresh the tree for whichever screen we're
    // looking at (each tree-view renderer replaces innerHTML cleanly).
    const activeScreen = document.querySelector('.screen.active');
    if (activeScreen?.id === 'favorites') {
        // loadFavorites() routes to either loadFavGridPage (always
        // 'replace') or loadFavTreeView — both safe for a single delete.
        loadFavorites();
    } else if (libView === 'tree') {
        loadTreeView();
    }
    // Main library grid view: DOM removal above is sufficient.
}

function _removeLibCardsForFilename(filename) {
    // The grid uses data-play="<encoded filename>" on each card; the
    // tree's song rows use the same attribute. encodeURIComponent
    // matches what renderGridCards / the tree renderer emit.
    const encoded = encodeURIComponent(filename);
    const selector = `[data-play="${CSS.escape(encoded)}"]`;
    let removed = 0;
    for (const el of document.querySelectorAll(selector)) {
        el.remove();
        removed++;
    }
    if (removed === 0) return;
    // Decrement the visible count badges that loadGridPage / loadTreeView
    // populated. Counts come from the server's `total` so this is a
    // best-effort estimate until the next refetch, but it keeps the
    // displayed number consistent with what's on screen right now.
    for (const id of ['lib-count', 'fav-count']) {
        const el = document.getElementById(id);
        if (!el) continue;
        const m = (el.textContent || '').match(/^(\d+)/);
        if (!m) continue;
        const next = Math.max(0, parseInt(m[1], 10) - removed);
        el.textContent = (el.textContent || '').replace(/^\d+/, String(next));
    }
    _bumpLibNavGeneration();
}

async function syncLibrarySong(providerId, songId, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const { playWhenReady = false } = opts;
    if (!providerId || !songId) return;
    const currentState = _librarySyncState(providerId, songId);
    if (currentState && currentState.status === 'synced' && currentState.localFilename) {
        if (playWhenReady) playSong(encodeURIComponent(currentState.localFilename), undefined, { bridge: false });
        return currentState.result || { filename: currentState.localFilename };
    }
    if (currentState && currentState.status === 'syncing') return null;
    _setLibrarySyncState(providerId, songId, { status: 'syncing' });
    try {
        const capabilityApi = window.slopsmith && window.slopsmith.capabilities;
        let data = null;
        if (capabilityApi && typeof capabilityApi.command === 'function') {
            const result = await capabilityApi.command('library', 'sync-song', {
                requester: 'app.library',
                target: { providerId, songId },
                payload: opts,
            });
            if (result.outcome !== 'handled') throw new Error(result.reason || 'Library provider sync failed');
            data = result.payload && result.payload.result;
        } else {
            data = await _libraryProviderApi()?.syncSong?.(providerId, songId, opts);
        }
        if (!data) throw new Error('Library provider sync did not return a result');
        const localFilename = data.filename || data.localFilename || data.local_filename || data.playFilename || data.play_filename || '';
        const message = localFilename
            ? 'Ready to play'
            : (data.cachedPath ? 'Loaded to local cache' : 'Loaded');
        _setLibrarySyncState(providerId, songId, { status: 'synced', message, localFilename, result: data });
        _treeStats = null;
        _favTreeStats = null;
        _tuningNames = null;
        _libEpoch++;
        await loadLibrary(0);
        if (playWhenReady && localFilename) playSong(encodeURIComponent(localFilename), undefined, { bridge: false });
        return data;
    } catch (error) {
        _setLibrarySyncState(providerId, songId, { status: 'error', message: error.message || 'Unknown error' });
        console.warn('Remote library load failed:', error);
        return null;
    }
}

function _setLibrarySyncState(providerId, songId, state) {
    _librarySyncStates.set(_librarySyncKey(providerId, songId), state);
    _renderLibrarySyncState(providerId, songId);
}

function _renderLibrarySyncState(providerId, songId) {
    const state = _librarySyncState(providerId, songId);
    // Filter via dataset rather than building a CSS attribute selector —
    // CSS.escape is absent in some test environments and older runtimes,
    // and provider/song IDs are not constrained to CSS-safe strings.
    const encodedProvider = encodeURIComponent(providerId);
    const encodedSong = encodeURIComponent(songId);
    for (const status of document.querySelectorAll('[data-library-sync-status]')) {
        if (status.dataset.librarySyncProvider !== encodedProvider) continue;
        if (status.dataset.librarySyncSong !== encodedSong) continue;
        const layout = status.classList.contains('ml-1') ? 'inline' : 'block';
        status.className = _librarySyncStatusClass(state, layout);
        status.textContent = _librarySyncStatusText(state);
    }
}

// Delegated click handlers
document.addEventListener('click', e => {
    // Edit button
    const edit = e.target.closest('.edit-btn');
    if (edit) {
        e.stopPropagation();
        const entry = edit.closest('[data-play]');
        openEditModal(JSON.parse(edit.dataset.edit), entry);
        return;
    }
    // Favorite button
    const fav = e.target.closest('.fav-btn');
    if (fav) {
        e.stopPropagation();
        toggleFavorite(decodeURIComponent(fav.dataset.fav));
        return;
    }
    // Retune button
    const btn = e.target.closest('.retune-btn');
    if (btn) {
        e.stopPropagation();
        retuneSong(btn.dataset.retune, decodeURIComponent(btn.dataset.title), btn.dataset.tuning, btn.dataset.target || 'E Standard');
        return;
    }
    // Remote song card / row without a local playable file yet.
    const remoteEntry = e.target.closest('[data-library-song]');
    if (remoteEntry && !remoteEntry.dataset.play && !e.target.closest('button')) {
        const providerId = decodeURIComponent(remoteEntry.dataset.libraryProvider || '');
        if (!_providerSupports(providerId, 'song.sync')) return;
        _setLibSelection(remoteEntry, { focus: false });
        syncLibrarySong(
            providerId,
            decodeURIComponent(remoteEntry.dataset.librarySong || ''),
            { playWhenReady: true },
        );
        return;
    }
    // Song card / row — keep persistent selection in sync with mouse
    // clicks so arrow-keying after a click resumes from where the
    // user clicked, not from a stale highlight.
    // Guard: if the click originated from any <button> inside the
    // entry (e.g. a plugin-provided .sloppak-convert-btn that has no
    // own stopPropagation handler above), don't treat it as a play
    // action. Known action buttons (.fav-btn, .edit-btn, .retune-btn)
    // already return early via stopPropagation() above; this catches
    // any remaining button that bubbles through.
    const card = e.target.closest('[data-play]');
    if (card && !e.target.closest('button')) {
        _setLibSelection(card, { focus: false });
        playSong(card.dataset.play, undefined, { bridge: false });
    }
});

// ── Scan banner (non-blocking) ──────────────────────────────────────────
function showScanBanner() {
    if (document.getElementById('scan-banner')) return;
    const el = document.createElement('div');
    el.id = 'scan-banner';
    el.className = 'fixed bottom-0 left-0 right-0 z-50 bg-dark-700/95 backdrop-blur border-t border-gray-700 px-6 py-3 flex items-center gap-4';
    el.innerHTML = `
        <div class="flex-1">
            <div class="flex items-center gap-3 mb-1">
                <span class="text-sm font-semibold text-white">Importing Library</span>
                <span class="text-xs text-gray-400" id="scan-progress">0 / 0</span>
            </div>
            <div class="progress-bar"><div class="fill" id="scan-bar" style="width:0%"></div></div>
            <p class="text-xs text-gray-500 mt-1 truncate" id="scan-file">Starting...</p>
            <p class="text-xs text-blue-400/70 mt-1 hidden" id="scan-first-note">First-time import — results are cached for future launches</p>
        </div>
        <button onclick="hideScanBanner()" class="px-3 py-1.5 bg-dark-600 hover:bg-dark-500 rounded-lg text-xs text-gray-400 transition flex-shrink-0">Dismiss</button>`;
    document.body.appendChild(el);
}

function hideScanBanner() {
    const el = document.getElementById('scan-banner');
    if (el) el.remove();
}

let _scanPollId = null;

async function pollScanStatus() {
    try {
        const resp = await fetch('/api/scan-status');
        const data = await resp.json();
        if (data.stage === 'error' && data.error) {
            // Surface the error in the banner and stop polling.
            showScanBanner();
            const file = document.getElementById('scan-file');
            const prog = document.getElementById('scan-progress');
            const firstNote = document.getElementById('scan-first-note');
            if (file) { file.textContent = 'Scan failed: ' + data.error; file.classList.add('text-red-400'); }
            if (prog) prog.textContent = 'Error';
            if (firstNote) firstNote.classList.add('hidden');
            clearInterval(_scanPollId);
            _scanPollId = null;
            return;
        }
        if (data.running) {
            showScanBanner();
            const pct = data.total > 0 ? Math.round(data.done / data.total * 100) : 0;
            const bar = document.getElementById('scan-bar');
            const prog = document.getElementById('scan-progress');
            const file = document.getElementById('scan-file');
            const firstNote = document.getElementById('scan-first-note');
            if (bar) bar.style.width = pct + '%';
            if (prog) prog.textContent = `${data.done} / ${data.total} (${pct}%)`;
            if (file) {
                const name = (data.current || '').replace(/_p\.psarc$/i, '').replace(/_/g, ' ');
                file.textContent = name || (data.stage === 'listing' ? 'Listing DLC folder...' : 'Processing...');
            }
            if (firstNote) firstNote.classList.toggle('hidden', !data.is_first_scan);
        } else {
            if (document.getElementById('scan-banner')) {
                hideScanBanner();
                _treeStats = null;  // Refresh stats
                loadLibrary();
            }
            clearInterval(_scanPollId);
            _scanPollId = null;
        }
    } catch (e) { /* ignore */ }
}

async function checkScanAndLoad() {
    const resp = await fetch('/api/scan-status');
    const data = await resp.json();
    if (data.running) {
        showScanBanner();
        const firstNote = document.getElementById('scan-first-note');
        if (firstNote) firstNote.classList.toggle('hidden', !data.is_first_scan);
        _scanPollId = setInterval(pollScanStatus, 1000);
    }
    loadLibrary();
}

// ── Plugin loader ───────────────────────────────────────────────────────
let _loadPluginsInFlight = false;
const _pluginUiContributions = new Map();
const CAPABILITY_INSPECTOR_NAV_SETTING = 'capability_inspector.showInPluginsMenu';

function _capabilityInspectorNavEnabled() {
    try { return localStorage.getItem(CAPABILITY_INSPECTOR_NAV_SETTING) === '1'; }
    catch (_) { return false; }
}

// Derive a display label from a (possibly string) nav value. `/api/plugins`
// can return `nav` as a plain string (manifest `"nav": "Declared"`) or an
// object with a `.label`, and _pluginNav() may synthesize an object (e.g. the
// Capability Inspector). Handle all three so string labels and the synthesized
// label aren't dropped in favour of the plugin name.
function _navLabel(nav, plugin) {
    if (typeof nav === 'string' && nav.trim()) return nav;
    if (nav && typeof nav === 'object' && nav.label) return nav.label;
    return (plugin && (plugin.name || plugin.id)) || '';
}

function _pluginNav(plugin) {
    if (!plugin || !plugin.id) return null;
    if (plugin.id === 'capability_inspector') {
        if (!_capabilityInspectorNavEnabled()) return null;
        return plugin.nav || { label: 'Capabilities', screen: 'plugin-capability_inspector' };
    }
    return plugin.nav || null;
}

async function _commandUiDomain(domain, command, plugin, payload) {
    try {
        if (!window.slopsmith?.capabilities?.command) return;
        await window.slopsmith.capabilities.command(domain, command, {
            requester: plugin.id || 'plugin',
            target: { id: payload.id, pluginId: plugin.id, region: payload.region },
            payload: { ...payload, pluginId: plugin.id },
        });
    } catch (e) {
        console.warn(`ui contribution ${command} failed for ${plugin.id}:`, e);
    }
}

async function _registerLegacyPluginUiContributions(plugin) {
    const previous = _pluginUiContributions.get(plugin.id) || [];
    for (const contribution of previous) {
        await _commandUiDomain(contribution.domain, 'unmount', plugin, contribution);
    }
    const contributions = [];
    const nav = _pluginNav(plugin);
    if (nav) {
        contributions.push({ domain: 'ui.navigation', id: `${plugin.id}:nav`, region: 'plugins', label: _navLabel(nav, plugin), mounted: true });
    }
    if (plugin.has_screen) {
        contributions.push({ domain: 'ui.plugin-screens', id: `${plugin.id}:screen`, region: 'plugin-screens', label: plugin.name || plugin.id, mounted: true });
    }
    if (plugin.has_settings) {
        contributions.push({ domain: 'settings', id: `${plugin.id}:settings`, region: 'plugin-settings', label: plugin.name || plugin.id, mounted: true });
    }
    if (plugin.type === 'visualization') {
        contributions.push({ domain: 'ui.player-overlays', id: `${plugin.id}:visualization`, region: 'visualization-picker', label: plugin.name || plugin.id, mounted: true });
    }
    contributions.sort((a, b) => `${a.domain}:${a.id}`.localeCompare(`${b.domain}:${b.id}`));
    _pluginUiContributions.set(plugin.id, contributions);
    for (const contribution of contributions) {
        await _commandUiDomain(contribution.domain, 'register-contribution', plugin, contribution);
        await _commandUiDomain(contribution.domain, 'mount', plugin, contribution);
    }
}

async function loadPlugins() {
    if (_loadPluginsInFlight) { console.log('[slopsmith] loadPlugins: in-flight, skipping'); return null; }
    _loadPluginsInFlight = true;
    console.log('[slopsmith] loadPlugins: start');
    let plugins;
    const navContainer = document.getElementById('nav-plugins');
    const mobileNavContainer = document.getElementById('mobile-nav-plugins');
    // Snapshot current nav so we can restore it if the fetch fails.
    const _savedNav = navContainer ? navContainer.innerHTML : null;
    const _savedMobileNav = mobileNavContainer ? mobileNavContainer.innerHTML : null;
    try {
        const resp = await fetch('/api/plugins');
        const fetchedPlugins = await resp.json();
        const capabilityPlugins = fetchedPlugins.slice().sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
        plugins = fetchedPlugins.slice().sort((a, b) => {
            const nameDelta = String(a.name || a.id || '').localeCompare(String(b.name || b.id || ''));
            return nameDelta || String(a.id || '').localeCompare(String(b.id || ''));
        });
        const livePluginIds = new Set(plugins.map((plugin) => plugin.id));
        for (const [pluginId, contributions] of _pluginUiContributions) {
            if (livePluginIds.has(pluginId)) continue;
            const stalePlugin = { id: pluginId };
            for (const contribution of contributions) {
                await _commandUiDomain(contribution.domain, 'unmount', stalePlugin, contribution);
            }
            try {
                window.slopsmith?.capabilities?.unregisterParticipant?.(pluginId);
            } catch (e) {
                console.warn(`capability participant unregister failed for ${pluginId}:`, e);
            }
            _pluginUiContributions.delete(pluginId);
        }
        console.log('[slopsmith] loadPlugins: got', plugins.length, 'plugins');

        try {
            const capabilityApi = window.slopsmith?.capabilities;
            if (capabilityApi?.registerParticipants) {
                capabilityApi.registerParticipants(capabilityPlugins);
                if (capabilityApi.registerCompatibilityShim) {
                    for (const plugin of capabilityPlugins) {
                        for (const shim of Array.isArray(plugin.compatibility_shims) ? plugin.compatibility_shims : []) {
                            capabilityApi.registerCompatibilityShim(shim);
                        }
                    }
                }
                capabilityApi.validateRuntime?.({ phase: 'plugin-manifest-load' });
            }
        } catch (e) {
            console.warn('[slopsmith] capability manifest registration failed:', e);
        }

        const settingsContainer = document.getElementById('plugin-settings');

        // Plugins whose screen.js has already been evaluated this session
        // at the current version AND whose DOM is still in the document.
        // Their listeners were bound to the existing settings / screen DOM,
        // so we must preserve that DOM — the script load guard below skips
        // re-evaluating screen.js, and a fresh empty DOM with no listeners
        // would leave the plugin half-hydrated on subsequent loadPlugins()
        // calls (e.g. the streamed refetches in _streamPluginStartup).
        //
        // The DOM-existence check is the safety net for plugins that
        // disappeared and reappeared between calls (uninstall + reinstall,
        // or a backend snapshot churn that drops a plugin then restores
        // it). In that case the loadedScripts key would still be set, but
        // any listeners are bound to elements that have since been removed
        // — drop the stale key so screen.js re-runs against the fresh DOM
        // we're about to inject.
        // Map<pluginId, version> — one entry per plugin. Storing only the
        // currently-loaded version (rather than a Set of all (id, version)
        // pairs ever loaded) means upgrade → downgrade → upgrade cycles
        // within one session don't leave stale keys that could mistakenly
        // mark an old version as already-hydrated. Coerce a legacy Set, if
        // present, to an empty Map — the previous shape never shipped.
        let loadedScripts = window.slopsmith._loadedPluginScripts;
        if (!(loadedScripts instanceof Map)) {
            loadedScripts = new Map();
            window.slopsmith._loadedPluginScripts = loadedScripts;
        }
        const _removePluginScriptTags = (pluginId) => {
            // Filter via dataset rather than a CSS attribute selector —
            // CSS.escape is not universally available, and plugin IDs
            // aren't constrained server-side.
            document.querySelectorAll('script[data-plugin-id]').forEach((s) => {
                if (s.dataset.pluginId === pluginId) s.remove();
            });
        };
        // Mirror of loadedScripts for the plugin `styles` capability: a single
        // versioned <link rel=stylesheet> per plugin lives in <head>, deduped by
        // id → version so an upgrade swaps it and re-activation doesn't pile up
        // duplicate tags. The <link> covers both the plugin's screen and its
        // settings panel. Plugins ship preflight-off (utilities only) CSS, so a
        // stylesheet that lingers after deactivation can't bleed a base reset.
        let loadedStyles = window.slopsmith._loadedPluginStyles;
        if (!(loadedStyles instanceof Map)) {
            loadedStyles = new Map();
            window.slopsmith._loadedPluginStyles = loadedStyles;
        }
        const _removePluginStyleTags = (pluginId) => {
            // Same dataset-filter rationale as _removePluginScriptTags.
            document.querySelectorAll('link[data-plugin-id]').forEach((l) => {
                if (l.dataset.pluginId === pluginId) l.remove();
            });
        };
        const _injectPluginStyles = (plugin) => {
            // Tear down a <link> we injected earlier this session when the plugin
            // no longer ships a usable stylesheet — upgraded to drop `styles`, or
            // to an invalid path — so stale CSS can't keep applying after the
            // plugin disabled its styling.
            const teardownStale = () => {
                if (loadedStyles.has(plugin.id)) {
                    _removePluginStyleTags(plugin.id);
                    loadedStyles.delete(plugin.id);
                }
            };
            if (!plugin.has_styles || !plugin.styles) { teardownStale(); return; }
            // `styles` is a plugin-root-relative path (like screen/script/routes)
            // and must live under assets/ so it serves through the sandboxed
            // asset route — e.g. "assets/plugin.css". Reject anything that can't
            // reach a served file or would build a malformed URL: not under
            // assets/, a `..` traversal segment, a backslash, or a `?`/`#` that
            // would collide with the cache-busting query we append. The server
            // also enforces containment via safe_join — this just avoids the
            // wasted 404 and matches the documented contract.
            const path = String(plugin.styles).replace(/^\/+/, '');
            const unsafe = !path.startsWith('assets/')
                || /(^|\/)\.\.(\/|$)/.test(path)
                || /[\\?#]/.test(path);
            if (unsafe) {
                console.warn(`Plugin ${plugin.id}: styles must be a path under assets/ with no "..", backslash, or query/fragment (got "${plugin.styles}") — skipping`);
                teardownStale();
                return;
            }
            const wantedVersion = plugin.version || '';
            // Idempotent: same id+version already injected → nothing to do.
            if (loadedStyles.get(plugin.id) === wantedVersion) return;
            // A different version (or none) was loaded — drop the prior <link>
            // so we never accumulate stale stylesheets across upgrades.
            _removePluginStyleTags(plugin.id);
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.dataset.pluginId = plugin.id;
            link.dataset.pluginVersion = wantedVersion;
            // Version in the URL (the plugin `version`, mirroring the screen.js
            // loader's ?v= convention) so a plugin upgrade within one session
            // fetches fresh CSS instead of a copy cached by path alone.
            const v = encodeURIComponent(wantedVersion);
            link.href = `/api/plugins/${plugin.id}/${path}${v ? `?v=${v}` : ''}`;
            // Cascade ordering: insert this <link> BEFORE core's prebuilt
            // Tailwind (/static/tailwind.min.css) instead of appending at the
            // end of <head>. A plugin that ships a full utility build — the
            // default output of running the Tailwind CLI without a scoped
            // content config — re-defines core utilities like .grid /
            // .xl:grid-cols-4; appended last, those equal-specificity rules
            // would win on source order and clobber core's responsive layout
            // (e.g. the library grid collapses to 2 columns, the nav bar
            // breaks). Loading the plugin sheet first means core wins any
            // EQUAL-specificity collision, while the plugin's own namespaced
            // classes still apply. A plugin can still deliberately override core
            // via higher-specificity selectors or !important — this only removes
            // the accidental source-order clobber.
            const coreSheet =
                document.head.querySelector('link[rel="stylesheet"][href*="tailwind.min.css"]')
                || document.head.querySelector('link[rel="stylesheet"]');
            if (coreSheet) {
                document.head.insertBefore(link, coreSheet);
            } else {
                document.head.appendChild(link);
            }
            loadedStyles.set(plugin.id, wantedVersion);
        };
        const _reconcilePluginStyles = (currentPlugins) => {
            // Drop stylesheets for plugins that vanished from /api/plugins or are
            // no longer ready+styled this round. _injectPluginStyles below only
            // visits plugins still returned by the API, so an uninstalled or
            // newly-not-ready plugin would otherwise keep its <link> applying.
            const styled = new Set(
                currentPlugins
                    .filter((p) => (p.status || 'ready') === 'ready' && p.has_styles && p.styles)
                    .map((p) => p.id),
            );
            for (const id of Array.from(loadedStyles.keys())) {
                if (!styled.has(id)) {
                    _removePluginStyleTags(id);
                    loadedStyles.delete(id);
                }
            }
        };
        const existingSettingsByPluginId = new Map();
        if (settingsContainer) {
            for (const child of settingsContainer.children) {
                const pid = child.dataset ? child.dataset.pluginId : null;
                if (pid) existingSettingsByPluginId.set(pid, child);
            }
        }
        const alreadyHydrated = new Set();
        for (const p of plugins) {
            if (!p.has_script) continue;
            // Version must match exactly — an upgrade / downgrade has to
            // re-run the new script against fresh DOM.
            if (loadedScripts.get(p.id) !== (p.version || '')) continue;
            const screenOk = !p.has_screen || !!document.getElementById(`plugin-${p.id}`);
            const settingsOk = !p.has_settings || existingSettingsByPluginId.has(p.id);
            if (screenOk && settingsOk) {
                alreadyHydrated.add(p.id);
            } else {
                // DOM was wiped externally (uninstall + reinstall, snapshot
                // churn) — drop the entry and remove the orphaned <script>
                // so screen.js re-runs against fresh DOM below.
                loadedScripts.delete(p.id);
                _removePluginScriptTags(p.id);
            }
        }

        // Clear plugin-owned containers, but keep already-hydrated plugins'
        // settings / screen DOM. Nav links carry no per-plugin script state,
        // so always rebuild them.
        navContainer.innerHTML = '';
        mobileNavContainer.innerHTML = '<span class="text-xs text-gray-600 uppercase tracking-wider">Plugins</span>';
        if (settingsContainer) {
            [...settingsContainer.children].forEach((el) => {
                const pid = el.dataset ? el.dataset.pluginId : null;
                if (!pid || !alreadyHydrated.has(pid)) el.remove();
            });
        }
        document.querySelectorAll('.screen[id^="plugin-"]').forEach((el) => {
            // dataset.pluginId is the source of truth (set on injection);
            // the id-prefix fallback covers screens injected before this
            // change shipped — both forms strip a single leading "plugin-".
            const pid = (el.dataset && el.dataset.pluginId)
                || el.id.replace(/^plugin-/, '');
            if (!alreadyHydrated.has(pid)) el.remove();
        });

        // Plugin settings area hosts both "Plugin Updates" and per-plugin
        // collapsibles. Reveal it whenever any plugins are installed —
        // updates are relevant even for plugins that contribute no settings.
        if (plugins.length > 0) {
            const area = document.getElementById('plugin-settings-area');
            if (area) area.classList.remove('hidden');
        }

        // Build plugin dropdown for desktop nav
        const navPlugins = plugins.map(plugin => ({ plugin, nav: _pluginNav(plugin) })).filter(entry => entry.nav);
        if (navPlugins.length > 0) {
            const dropdown = document.createElement('div');
            dropdown.className = 'relative';
            dropdown.innerHTML = `
                <button class="text-sm text-gray-400 hover:text-white transition flex items-center gap-1" onclick="this.nextElementSibling.classList.toggle('hidden')">
                    Plugins
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                </button>
                <div class="hidden absolute top-full left-0 mt-2 bg-dark-800 border border-gray-700 rounded-xl shadow-xl py-2 min-w-[180px] max-h-[80vh] overflow-y-auto z-50" id="plugin-dropdown"></div>`;
            navContainer.appendChild(dropdown);
            const ddMenu = dropdown.querySelector('#plugin-dropdown');

            // Close the plugin dropdown when clicking outside it. Bind ONCE:
            // loadPlugins() re-runs on every plugin status change during
            // startup (SSE-driven refetches), and each run rebuilds `dropdown`
            // / `ddMenu`. A per-run addEventListener would leak a new global
            // click listener on every refetch, each closing over a now-detached
            // dropdown. The one-time handler instead resolves the LIVE dropdown
            // from the DOM at click time, so it always targets the current one.
            if (!window.slopsmith._pluginDropdownOutsideClickBound) {
                window.slopsmith._pluginDropdownOutsideClickBound = true;
                document.addEventListener('click', (e) => {
                    const menu = document.getElementById('plugin-dropdown');
                    if (!menu) return;
                    const container = menu.parentElement;
                    if (container && !container.contains(e.target)) menu.classList.add('hidden');
                });
            }

            for (const { plugin, nav } of navPlugins) {
                const screenId = `plugin-${plugin.id}`;
                // A plugin is navigable only once it's ready. While its deps
                // install (status "installing") or after a failed load
                // (status "failed") we still render the nav slot — disabled,
                // with an "installing…" suffix or the error as a tooltip — so
                // the nav is stable and the user sees the plugin is coming
                // (#421). Entries without a status (legacy / stub) are ready.
                const status = plugin.status || 'ready';
                const isReady = status === 'ready';
                // nav is truthy here (navPlugins is filtered on entry.nav), and
                // is the computed value from _pluginNav() — which may be a
                // string, an object that omits `label`, or a synthesized object
                // (e.g. the Capability Inspector). _navLabel() normalizes all
                // three and falls back to name/id so a missing label never
                // renders "undefined" or throws. Use the loop's `nav`, not the
                // raw `plugin.nav`, so string and synthesized labels survive.
                const label = _navLabel(nav, plugin);

                const item = document.createElement('a');
                item.href = '#';
                ddMenu.appendChild(item);
                // Mobile nav — flat list
                const ma = document.createElement('a');
                ma.href = '#';
                mobileNavContainer.appendChild(ma);

                if (isReady) {
                    item.className = 'block px-4 py-2 text-sm text-gray-400 hover:text-white hover:bg-dark-700 transition';
                    item.textContent = label;
                    item.onclick = (e) => { e.preventDefault(); ddMenu.classList.add('hidden'); showScreen(screenId); window.slopsmithDemoTrack?.('event/plugin-open/' + plugin.id); };
                    ma.className = 'text-gray-400 hover:text-white pl-4 text-sm';
                    ma.textContent = label;
                    ma.onclick = (e) => { e.preventDefault(); showScreen(screenId); ma.closest('#mobile-menu').classList.add('hidden'); window.slopsmithDemoTrack?.('event/plugin-open/' + plugin.id); };
                } else {
                    const installing = status === 'installing';
                    const suffix = installing ? ' (installing…)' : ' (failed)';
                    const tip = installing
                        ? 'This plugin is installing its dependencies and will become available shortly.'
                        : (plugin.error || 'This plugin failed to load. Check the server startup log for details.');
                    // Disabled appearance: dimmed, default cursor, no nav handler.
                    const cls = 'block px-4 py-2 text-sm text-gray-600 cursor-default select-none'
                        + (installing ? ' animate-pulse' : '');
                    item.className = cls;
                    item.setAttribute('aria-disabled', 'true');
                    item.title = tip;
                    item.textContent = label + suffix;
                    // Drop disabled entries out of the tab order and strip the
                    // href so keyboard/screen-reader users don't land on a
                    // non-actionable "link" (a11y). Swallow clicks too, in case
                    // it's still reached via mouse.
                    item.removeAttribute('href');
                    item.setAttribute('tabindex', '-1');
                    item.onclick = (e) => { e.preventDefault(); };
                    ma.className = 'pl-4 text-sm text-gray-600 cursor-default select-none' + (installing ? ' animate-pulse' : '');
                    ma.setAttribute('aria-disabled', 'true');
                    ma.title = tip;
                    ma.textContent = label + suffix;
                    ma.removeAttribute('href');
                    ma.setAttribute('tabindex', '-1');
                    ma.onclick = (e) => { e.preventDefault(); };
                }
            }
        }

        // Tear down stylesheets for plugins that are gone / no longer styled
        // before (re)injecting for the current set.
        _reconcilePluginStyles(plugins);

        for (const plugin of plugins) {
            try {
            // Only ready plugins have their assets available (the backend
            // guards screen.html/screen.js/settings.html on status=="ready").
            // Installing/failed plugins contribute only the disabled nav slot
            // built above — skip screen/settings/script injection for them.
            if (plugin.status && plugin.status !== 'ready') continue;
            await _registerLegacyPluginUiContributions(plugin);
            const screenId = `plugin-${plugin.id}`;

            // Inject the plugin's stylesheet FIRST (before screen HTML/JS) so
            // its utilities are present on first paint. Idempotent + version-
            // deduped, so it's safe to call for already-hydrated plugins too.
            _injectPluginStyles(plugin);

            // Inject screen container. Skip for already-hydrated plugins —
            // their existing screen DOM still has the listeners that
            // screen.js bound on first load (rebuilding here would orphan
            // them, since the script load guard further down won't re-run
            // screen.js to re-bind).
            if (plugin.has_screen && !alreadyHydrated.has(plugin.id)) {
                const screenDiv = document.createElement('div');
                screenDiv.id = screenId;
                screenDiv.className = 'screen';
                screenDiv.dataset.pluginId = plugin.id;
                screenDiv.dataset.pluginVersion = plugin.version || '';
                // Insert before the player screen
                const player = document.getElementById('player');
                player.parentNode.insertBefore(screenDiv, player);

                const htmlResp = await fetch(`/api/plugins/${plugin.id}/screen.html`);
                screenDiv.innerHTML = await htmlResp.text();
            }

            // Inject settings section — wrapped in a collapsible <details>
            // per plugin so the page stays scannable as plugins accumulate.
            // Collapsed by default; <details>/<summary> handles state natively.
            // Skip for already-hydrated plugins — preserved details element
            // still carries listeners wired by its inline settings script
            // and by screen.js on first load.
            if (plugin.has_settings && settingsContainer && !alreadyHydrated.has(plugin.id)) {
                const details = document.createElement('details');
                details.className = 'bg-dark-700/40 border border-gray-800 rounded-xl overflow-hidden group';
                details.dataset.pluginId = plugin.id;
                details.dataset.pluginVersion = plugin.version || '';

                const summary = document.createElement('summary');
                // .plugin-settings-summary class hides the browser's native
                // disclosure triangle (see style.css) so only our chevron shows.
                // flex-col allows the fallback explanation note to appear below
                // the name/badges row when plugin.fallback is set.
                summary.className = 'plugin-settings-summary cursor-pointer select-none px-4 py-3 text-sm font-medium text-gray-300 hover:bg-dark-700/70 transition flex flex-col';
                // Inner row: plugin name/badges (left) + chevron (right).
                const headerRow = document.createElement('span');
                headerRow.className = 'flex items-center justify-between';
                const labelWrap = document.createElement('span');
                labelWrap.className = 'flex items-center gap-2';
                const labelSpan = document.createElement('span');
                labelSpan.textContent = plugin.name || plugin.id;
                labelWrap.appendChild(labelSpan);
                // "Bundled" marker (slopsmith#160). Visually distinguishes
                // plugins that ship with the default container image from
                // user-installed ones so users don't try to remove a core
                // plugin via the manage-plugin flow and brick a feature
                // that's expected to "just work".
                if (plugin.bundled) {
                    const bundledDesc = 'This plugin ships with Slopsmith core and is expected to be present.';
                    const badge = document.createElement('span');
                    badge.className = 'inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-purple-400/30 bg-purple-500/10 text-purple-300';
                    badge.title = bundledDesc;
                    badge.setAttribute('aria-label', 'Bundled — ' + bundledDesc);
                    badge.setAttribute('role', 'img');
                    badge.innerHTML = `
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                                  d="M12 11c1.657 0 3-1.343 3-3V6a3 3 0 10-6 0v2c0 1.657 1.343 3 3 3zM6 11h12a2 2 0 012 2v6a2 2 0 01-2 2H6a2 2 0 01-2-2v-6a2 2 0 012-2z"/>
                        </svg>
                        Bundled
                    `;
                    labelWrap.appendChild(badge);
                }
                // "Fallback" warning badge: the bundled copy failed to load its
                // routes, so the server fell back to this older user-installed
                // copy.  Warn users so they know the bundled build is broken and
                // can check the server startup log for the root cause.
                if (plugin.fallback) {
                    const fbBadge = document.createElement('span');
                    fbBadge.className = 'inline-flex items-center gap-1 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-yellow-400/40 bg-yellow-500/10 text-yellow-300';
                    fbBadge.setAttribute('aria-hidden', 'true');
                    fbBadge.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg> Fallback';
                    labelWrap.appendChild(fbBadge);
                }
                // Assemble inner header row: [name/badges (left)] [chevron (right)].
                // Both are placed in headerRow so the fallback note (if any)
                // can sit below the entire row as a second flex-col child of
                // summary, rather than being squeezed inline beside the chevron.
                headerRow.appendChild(labelWrap);
                // Chevron icon — built via setAttributeNS so the SVG sits in
                // the SVG namespace and renders correctly. Plugin label is
                // appended as text above so manifest values can't inject HTML.
                const svgNS = 'http://www.w3.org/2000/svg';
                const svg = document.createElementNS(svgNS, 'svg');
                svg.setAttribute('class', 'w-4 h-4 text-gray-500 transition-transform group-open:rotate-180');
                svg.setAttribute('fill', 'none');
                svg.setAttribute('stroke', 'currentColor');
                svg.setAttribute('viewBox', '0 0 24 24');
                const svgPath = document.createElementNS(svgNS, 'path');
                svgPath.setAttribute('stroke-linecap', 'round');
                svgPath.setAttribute('stroke-linejoin', 'round');
                svgPath.setAttribute('stroke-width', '2');
                svgPath.setAttribute('d', 'M19 9l-7 7-7-7');
                svg.appendChild(svgPath);
                headerRow.appendChild(svg);
                summary.appendChild(headerRow);
                // Fallback explanation note: a visible <p> below the header row,
                // accessible to touch/keyboard users (browser tooltip via title/
                // aria-label alone is hover-only and insufficient). Appended to
                // summary (not labelWrap) so it renders as the second child in
                // summary's flex-col layout, appearing below the name+badges row.
                if (plugin.fallback) {
                    const fbNote = document.createElement('span');
                    fbNote.className = 'block text-xs text-yellow-300/80 mt-1';
                    fbNote.textContent = 'The bundled version failed to start. This user-installed copy is serving as a fallback. Check the server startup log for details.';
                    summary.appendChild(fbNote);
                }
                details.appendChild(summary);

                const body = document.createElement('div');
                body.id = `plugin-settings-${plugin.id}`;
                body.className = 'px-4 py-4 border-t border-gray-800 space-y-4';
                details.appendChild(body);

                settingsContainer.appendChild(details);

                const settingsResp = await fetch(`/api/plugins/${plugin.id}/settings.html`);
                body.innerHTML = await settingsResp.text();
                // <script> tags inserted via innerHTML are intentionally
                // inert per the HTML5 spec — the browser parses them as
                // DOM nodes but never runs the body. That silently breaks
                // any plugin settings.html that wires event handlers via
                // addEventListener (e.g. file pickers, anything that
                // can't be expressed as an inline onclick=… attribute),
                // and any inline IIFE that hydrates form values from
                // localStorage. Re-create each script node — script
                // elements created via document.createElement DO execute
                // when appended — so plugins get the script behavior
                // they'd expect from a normal HTML document.
                body.querySelectorAll('script').forEach(oldScript => {
                    const newScript = document.createElement('script');
                    for (const attr of oldScript.attributes) {
                        newScript.setAttribute(attr.name, attr.value);
                    }
                    newScript.textContent = oldScript.textContent;
                    oldScript.parentNode.replaceChild(newScript, oldScript);
                });

            }

            // Load plugin JS
            if (plugin.has_script) {
                const wantedVersion = plugin.version || '';
                if (loadedScripts.get(plugin.id) !== wantedVersion) {
                    // A different version (or none) was loaded previously —
                    // remove the prior <script> tag for this plugin id so we
                    // don't accumulate stale versions on upgrade/downgrade.
                    _removePluginScriptTags(plugin.id);
                    await new Promise((resolve, reject) => {
                        const script = document.createElement('script');
                        // Include version in URL so a plugin upgrade within the
                        // same browser session fetches the new screen.js instead
                        // of a cached copy keyed only by path (matches the art
                        // URL ?v=mtime convention elsewhere in this file).
                        const v = encodeURIComponent(wantedVersion);
                        script.src = `/api/plugins/${plugin.id}/screen.js${v ? `?v=${v}` : ''}`;
                        script.dataset.pluginId = plugin.id;
                        script.dataset.pluginVersion = wantedVersion;
                        window.slopsmith._loadingPluginId = plugin.id;
                        script.onload = () => {
                            if (window.slopsmith._loadingPluginId === plugin.id) delete window.slopsmith._loadingPluginId;
                            loadedScripts.set(plugin.id, wantedVersion);
                            resolve();
                        };
                        script.onerror = (err) => {
                            if (window.slopsmith._loadingPluginId === plugin.id) delete window.slopsmith._loadingPluginId;
                            loadedScripts.delete(plugin.id);
                            reject(err);
                        };
                        document.body.appendChild(script);
                    });
                }
            }
            } catch (e) {
                console.warn(`Plugin '${plugin.id}' failed to load, skipping:`, e);
            }
        }
    } catch (e) {
        console.error('Failed to load plugins:', e);
        // Restore nav so a failed re-hydration call doesn't leave it blank.
        if (_savedNav !== null && navContainer) navContainer.innerHTML = _savedNav;
        if (_savedMobileNav !== null && mobileNavContainer) mobileNavContainer.innerHTML = _savedMobileNav;
        _loadPluginsInFlight = false;
        return null;
    }
    _loadPluginsInFlight = false;
    return plugins;
}

// Re-run loadPlugins (and the viz picker, since a newly-ready plugin may
// register a window.slopsmithViz_<id> factory) when plugin status changes.
// Debounced so a burst of plugin-registered/plugin-error events during
// startup collapses into a single refetch.
let _pluginRefreshTimer = null;
function _refreshPluginsSoon() {
    clearTimeout(_pluginRefreshTimer);
    _pluginRefreshTimer = setTimeout(async () => {
        const plugins = await loadPlugins();
        if (plugins) {
            _populateVizPicker(plugins);
        } else {
            // loadPlugins() returned null because a refetch was already in
            // flight, so this status change would otherwise be dropped. Re-arm
            // the debounce so the newer state is still applied once the
            // in-flight load finishes. Reuses the 250ms delay (and the
            // in-flight guard clears quickly), so this can't tight-loop.
            _refreshPluginsSoon();
        }
    }, 250);
}

let _pluginStreamStarted = false;
function _streamPluginStartup() {
    // Watch the SAME /api/startup-status/stream the splash used to gate on.
    // Instead of blocking, we let the nav render immediately (loadPlugins ran
    // already) and refetch whenever a plugin graduates to ready or fails — so
    // its nav slot flips from "installing…" to active/failed without a reload
    // (#421). loadPlugins is idempotent (in-flight guard + version map), so
    // extra refetches are cheap and safe.
    if (_pluginStreamStarted) return;
    _pluginStreamStarted = true;

    if (typeof EventSource === 'undefined') { _pollPluginStartup(); return; }

    const es = new EventSource('/api/startup-status/stream');
    es.onmessage = (event) => {
        let status;
        try { status = JSON.parse(event.data); } catch { return; }
        if (!status || status.type === 'keepalive') return;
        const phase = (status.phase || '').trim();
        if (phase === 'plugin-registered' || phase === 'plugin-error') {
            _refreshPluginsSoon();
        }
        // Terminal: one last refetch to catch anything missed, then stop.
        if (!status.running && (phase === 'complete' || phase === 'error')) {
            _refreshPluginsSoon();
            es.close();
        }
    };
    es.onerror = () => {
        // Stream dropped (proxy buffering, backend hiccup). Stop retrying the
        // stream and fall back to a bounded poll so late installs still surface.
        es.close();
        _pollPluginStartup();
    };
}

let _pollStartupStarted = false;
async function _pollPluginStartup() {
    // SSE-unavailable fallback: poll /api/startup-status until the backend
    // finishes its plugin loader, refetching whenever the ready count changes
    // or it goes terminal. Bounded so a backend that never finishes doesn't
    // poll forever.
    if (_pollStartupStarted) return;
    _pollStartupStarted = true;
    // Generous headroom over the documented worst case (whisperx → torch et al.
    // can take 20-30 min): a 30-min ceiling would stop polling right as a
    // slipping install — slow mirror, pip retry — actually finishes. 60 min
    // leaves margin so the late graduation still surfaces. (#421)
    const DEADLINE_MS = 60 * 60 * 1000;
    const start = Date.now();
    // Track a composite signature, not just the ready count: a plugin can fail
    // (phase → "plugin-error", current_plugin/error change) without changing
    // `loaded`, e.g. the next plugin breaks after all prior ones succeeded.
    // Watching only `loaded` would miss that transition until some later
    // ready-count change or terminal completion, so the failed/error nav state
    // wouldn't surface. Refetch whenever any of these move.
    let lastSig = null;
    while (Date.now() - start < DEADLINE_MS) {
        await new Promise((r) => setTimeout(r, 3000));
        try {
            const resp = await fetch('/api/startup-status');
            if (!resp.ok) continue;
            const status = await resp.json();
            const sig = JSON.stringify([
                Number(status.loaded || 0),
                status.phase || '',
                status.current_plugin || '',
                status.error || '',
            ]);
            if (sig !== lastSig) { lastSig = sig; _refreshPluginsSoon(); }
            if (!status.running) { _refreshPluginsSoon(); return; }
        } catch (_e) { /* network error — keep trying */ }
    }
}

async function bootstrapPluginsAndUi() {
    // #421: never gate the nav on full plugin startup. Render it immediately
    // from /api/plugins (ready plugins active; installing/failed disabled),
    // then stream plugin status so each entry resolves in place as its
    // dependencies finish installing or its load fails.
    const plugins = await loadPlugins();
    _streamPluginStartup();
    return plugins;
}

// Load library on start. loadSettings is awaited alongside so persisted
// values (A/V offset, mastery, etc.) are applied to the highway + HUD
// before any playSong runs — otherwise a fast click could start
// playback with stale settings before /api/settings returned.
(async () => {
    // Splitscreen pop-out windows (`?ssFollower=1`) load this same app but
    // get driven into "follower mode" by the splitscreen plugin once it
    // loads — which is *after* this init runs. Without this, the library
    // (`#home`, marked `active` in index.html) renders and paints first, so
    // the popup briefly flashes the song grid before swapping to the player.
    // Switch to the player screen up front so the popup shows player chrome
    // (empty, then populated by the plugin) the whole time. The wasted
    // library fetch below is negligible next to the whole-app + every-plugin
    // re-load a popup already does.
    const isFollowerWindow = (() => {
        try { return new URLSearchParams(location.search).get('ssFollower') === '1'; }
        catch (_) { return false; }
    })();
    if (isFollowerWindow) {
        // Await it — showScreen is async, so a bare call would turn even a
        // synchronous DOM error into an unhandled rejection that this try
        // couldn't catch. Surface failures (e.g. `#player` missing/renamed)
        // instead of silently bringing the library flash back.
        try { await showScreen('player'); }
        catch (e) { console.warn('[slopsmith] follower-window: showScreen("player") failed:', e); }
    }
    await loadLibraryProviders({ restoreSaved: true });
    // Restore library-filter UI state from localStorage before the first
    // grid fetch so the badge/chips are accurate immediately
    // (slopsmith#129).
    _renderLibFilterChips();
    _updateLibFiltersBadge();
    // Restore the persisted sort and format-filter dropdowns BEFORE
    // the first setLibView() call — setLibView triggers loadLibrary,
    // which reads `lib-sort` / `lib-format` to build the API query
    // string. Without this, the first page would always load with
    // "Artist A-Z" / "All formats" regardless of what the user had
    // picked previously.
    const savedSort = _readPersistedChoice(_LIB_SORT_KEY, _LIB_SORT_VALUES, 'artist');
    const savedFormat = _readPersistedChoice(_LIB_FORMAT_KEY, _LIB_FORMAT_VALUES, '');
    const sortEl = document.getElementById('lib-sort');
    const fmtEl = document.getElementById('lib-format');
    if (sortEl) sortEl.value = savedSort;
    if (fmtEl) fmtEl.value = savedFormat;
    // Treat the initial page load the same as a screen entry so the
    // restored selection scrolls into view exactly once on hard
    // reload. Without this, the scroll-on-screen-entry flag only
    // ever triggered when the user navigated away and back via
    // showScreen — a hard refresh in tree mode would land on the
    // top of the tree and force the user to scroll back to find
    // their selection.
    _libScrollOnNextRender.home = true;
    // `libView` was already initialized from localStorage at module
    // load; passing it through setLibView replays the visibility
    // toggling and triggers the initial load.
    setLibView(libView);
    try { await loadSettings(); } catch (e) { console.warn('initial loadSettings failed:', e); }
    // App-wide restart banner — must wire once, outside loadSettings(), so a
    // download finishing while the user is on a non-Settings screen still
    // pops the banner.
    try { initAppUpdateBanner(); } catch (e) { console.warn('initAppUpdateBanner failed:', e); }
    // Seed the track fill on every themed slider so they render correctly
    // before any interaction — e.g. the speed slider (untouched by
    // loadSettings) before the first playSong, or follower windows that
    // enter the player screen via showScreen('player') without playSong.
    document.querySelectorAll('.slider-input').forEach(el => handleSliderInput(el));
    _ensureSpeedSliderWired();
    checkScanAndLoad();

    const plugins = await bootstrapPluginsAndUi();
    await loadLibraryProviders({ restoreSaved: true, reloadOnChange: true });
    // Viz picker depends on plugin scripts having loaded (to find
    // window.slopsmithViz_<id> factories), so run it after loadPlugins.
    // Reuse the plugin list loadPlugins just fetched — no need to
    // round-trip /api/plugins a second time.
    _populateVizPicker(plugins);
    // Alpha-build heads-up banner — only revealed when the running version
    // string contains "alpha" (case-insensitive). Stays hidden on stable,
    // beta, RC, or any other channel. The banner element lives in the
    // library-section markup; toggling the `hidden` Tailwind utility is the
    // entire surface area, so a test harness can sandbox this against a
    // minimal document stub.
    function _updateAlphaWarningBanner(version) {
        const banner = document.getElementById('alpha-warning-banner');
        if (!banner) return;
        const isAlpha = typeof version === 'string'
            && version.toLowerCase().includes('alpha');
        banner.classList.toggle('hidden', !isAlpha);
    }
    fetch('/api/version')
        .then(r => { if (!r.ok) throw new Error(); return r.json(); })
        .then(d => {
            const v = typeof d.version === 'string' ? d.version.trim() : '';
            if (v && v.toLowerCase() !== 'unknown') {
                const navEl = document.getElementById('app-version');
                if (navEl) navEl.textContent = 'v' + v;
                const aboutEl = document.getElementById('app-version-about');
                if (aboutEl) aboutEl.textContent = 'v' + v;
            }
            _updateAlphaWarningBanner(v);
            // Defense-in-depth: server validates the env-var-supplied URLs,
            // but the About <a href> values are configurable so the UI also
            // rejects anything that isn't http(s) with a non-empty hostname.
            // A bare regex prefix check would accept malformed values like
            // "https://" — `new URL` + protocol + hostname catches them
            // (and `hostname`, not `host`, so port-only authorities like
            // "http://:80/path" are rejected too).
            // The source and license links are checked independently so a
            // rejected source_url doesn't gate a valid license_url.
            const isSafeHref = (u) => {
                if (typeof u !== 'string' || !u) return false;
                try {
                    const parsed = new URL(u);
                    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
                    // `host` includes the port — "http://:80/path" has
                    // host ":80" but no real hostname. `hostname` is what
                    // we actually want.
                    return !!parsed.hostname;
                } catch (_) {
                    return false;
                }
            };
            if (isSafeHref(d.source_url)) {
                const srcLink = document.getElementById('about-source-link');
                if (srcLink) srcLink.href = d.source_url;
            }
            if (isSafeHref(d.license_url)) {
                const licLink = document.getElementById('about-license-link');
                if (licLink) licLink.href = d.license_url;
            }
        })
        .catch(() => {});
})();
