// Verify static/app.js emits `loop:restart` exactly once when the A-B
// loop wraps, with the documented payload shape. Plugins (notedetect's
// drill-mode score capture) consume this contract.
//
// The test does not load the full app.js into a DOM — it extracts just
// the `startCountIn` function source via brace-matching and evaluates it
// in a vm sandbox with stubbed dependencies. This trades coverage of the
// surrounding script for isolation: a failure here points at the wrap
// path, not at unrelated DOM coupling.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_JS = path.join(__dirname, '..', '..', 'static', 'app.js');

// Pull the source of `async function startCountIn(opts = {}) { ... }` by
// finding the declaration and brace-matching to the closing brace.
// Brittle by design: if the function gets renamed or restructured, the
// test fails loudly with "function not found" rather than passing on stale code.
const START_COUNT_IN_SIG = 'async function startCountIn(';
function extractFunction(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`extractFunction: '${signature}' not found in app.js`);
    let i = start + signature.length;
    // Skip the formal parameter list, including default-value object literals
    // like `opts = {}` — a naive indexOf('{') would grab the default, not the body.
    // Signatures for this helper end with '(' (e.g. startCountIn().
    let parenDepth = 1;
    while (i < src.length && parenDepth > 0) {
        const ch = src[i];
        if (ch === '(') parenDepth++;
        else if (ch === ')') parenDepth--;
        i++;
    }
    const openBrace = src.indexOf('{', i);
    if (openBrace === -1) throw new Error(`extractFunction: no body brace after '${signature}'`);
    let depth = 1;
    i = openBrace + 1;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    if (depth !== 0) throw new Error(`extractFunction: unbalanced braces after '${signature}'`);
    return src.slice(start, i);
}

function buildSandbox() {
    const emitCalls = [];
    const sandbox = {
        // Globals the function reads/writes via closure. Declared as `var`
        // in the eval prelude so they attach to the sandbox.
        loopA: 10,
        loopB: 20,
        _countingIn: false,
        isPlaying: false,
        lastAudioTime: 0,

        // Browser-ish globals.
        performance: { now: () => Date.now() },
        // requestAnimationFrame: skip to t >= 1 in one tick so the rewind
        // animation completes synchronously and we reach the `_audioSeek`
        // continuation immediately.
        requestAnimationFrame(fn) {
            // Fire with `now` far enough in the future that
            // (now - rewindStart) / rewindDuration >= 1.
            queueMicrotask(() => fn(Date.now() + 10_000));
        },
        // setTimeout: swallow. beginCount schedules ticks via setTimeout;
        // we don't need them to fire — the emit happens before beginCount.
        setTimeout: () => 0,

        // Stubbed slopsmith DOM dependencies.
        audio: { pause() {} },
        jucePlayer: { pause: () => Promise.resolve(), play: () => Promise.resolve(true) },
        highway: { setTime() {}, getBPM: () => 120 },

        // Stubbed app.js helpers.
        // Resolve with the real shape `{ completed, from, to }` so
        // startCountIn's loop-wrap callback sees completed=true and uses
        // r.to for highway.setTime / lastAudioTime.
        _audioSeek: (s) => Promise.resolve({ completed: true, from: 20, to: s }),
        playClick: () => {},
        showCountOverlay: () => {},
        hideCountOverlay: () => {},
        setPlayButtonState: () => {},

        // Stubbed DOM access. Anything querying for a button just gets a
        // permissive object that ignores writes.
        document: {
            getElementById: () => ({
                textContent: '',
                className: '',
                classList: { add() {}, remove() {}, toggle() {} },
            }),
        },

        // Spy: records every emit call so the test can assert.
        window: {
            slopsmith: {
                emit(event, detail) { emitCalls.push({ event, detail }); },
                isPlaying: false,
            },
            _juceMode: false,
        },

        // Capture for assertions.
        __emitCalls: emitCalls,
        queueMicrotask,
    };
    vm.createContext(sandbox);
    return sandbox;
}

test('loop:restart fires once when wrap path runs', async () => {
    const src = fs.readFileSync(APP_JS, 'utf8');
    const startCountInSrc = extractFunction(src, START_COUNT_IN_SIG);

    // Sanity check: the change under test is present at all. Catches
    // accidental revert before we even run the behavior assertion.
    assert.match(
        startCountInSrc,
        /window\.slopsmith\.emit\(\s*['"]loop:restart['"]/,
        'startCountIn is missing the loop:restart emit',
    );

    const sandbox = buildSandbox();
    // Re-declare the closure-scoped lets as vars so the function can read
    // them from the sandbox global, then define the function in-context.
    const prelude = `
        var loopA = ${sandbox.loopA};
        var loopB = ${sandbox.loopB};
        var _countingIn = false;
        var _countInGen = 0;
        var _countInTimer = null;
        var _countInRaf = 0;
        var isPlaying = false;
        var lastAudioTime = 0;
        ${startCountInSrc}
        globalThis.__startCountIn = startCountIn;
    `;
    vm.runInContext(prelude, sandbox);

    await sandbox.__startCountIn();
    // Allow the queued requestAnimationFrame microtask + the _audioSeek
    // promise chain to settle. Two awaits is enough: rAF microtask -> rewind
    // completion -> _audioSeek().then() -> emit.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const restarts = sandbox.__emitCalls.filter((c) => c.event === 'loop:restart');
    assert.equal(restarts.length, 1, `expected 1 loop:restart emit, got ${restarts.length}`);
    // Field-wise assertion: deepStrictEqual fails across vm-context object
    // realms because Object.prototype identities differ even when contents
    // match. Compare values, not prototype graphs.
    const detail = restarts[0].detail;
    assert.equal(detail.loopA, 10);
    assert.equal(detail.loopB, 20);
    assert.equal(detail.time, 10);
    assert.equal(Object.keys(detail).length, 3, `unexpected extra keys in detail: ${Object.keys(detail)}`);
});

test('loop:restart aborts when seek lands far from loopA (JUCE rollback)', async () => {
    // Regression: if jucePlayer.seek rolls back (currentTime stays put),
    // _audioSeek resolves with completed:true but r.to !== loopA. The
    // wrap handler must abort instead of running beginCount on the wrong
    // position and emitting a misleading loop:restart.
    const src = fs.readFileSync(APP_JS, 'utf8');
    const startCountInSrc = extractFunction(src, START_COUNT_IN_SIG);

    const sandbox = buildSandbox();
    // Override _audioSeek to mimic JUCE rollback: completed but to=from,
    // far from the requested loopA (10).
    sandbox._audioSeek = (s) => Promise.resolve({ completed: true, from: 20, to: 20 });
    const prelude = `
        var loopA = ${sandbox.loopA};
        var loopB = ${sandbox.loopB};
        var _countingIn = false;
        var _countInGen = 0;
        var _countInTimer = null;
        var _countInRaf = 0;
        var isPlaying = false;
        var lastAudioTime = 0;
        ${startCountInSrc}
        globalThis.__startCountIn = startCountIn;
        globalThis.__getCountingIn = () => _countingIn;
    `;
    vm.runInContext(prelude, sandbox);

    await sandbox.__startCountIn();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const restarts = sandbox.__emitCalls.filter((c) => c.event === 'loop:restart');
    assert.equal(restarts.length, 0, 'rollback must not emit loop:restart');
    assert.equal(sandbox.__getCountingIn(), false, '_countingIn must be cleared on abort');
});

test('count-in cancellation token bails delayed callbacks (rewindStep + tick)', () => {
    // Source-level assertion: the gen-capture pattern is in place so
    // teardown can interrupt an in-flight count-in. Behavioral simulation
    // of timer cancellation is out of scope for the static extractor; this
    // verifies the contract is wired into the source.
    const src = fs.readFileSync(APP_JS, 'utf8');
    const fn = extractFunction(src, START_COUNT_IN_SIG);
    // Captures gen at entry
    assert.match(fn, /const gen = _countInGen/, 'startCountIn must capture _countInGen at entry');
    // Each delayed callback bails on mismatch
    const guards = [...fn.matchAll(/if \(gen !== _countInGen\) return/g)];
    assert.ok(guards.length >= 4, `expected ≥4 gen-mismatch bails, found ${guards.length}`);
    // RAF and timer handles tracked so _cancelCountIn can cancel them
    assert.match(fn, /_countInRaf = requestAnimationFrame/, 'rewindStep must store its RAF handle in _countInRaf');
    assert.match(fn, /_countInTimer = setTimeout/, 'tick scheduling must store its timer in _countInTimer');
});

test('loop:restart fires after highway.setTime, before beginCount', () => {
    // Source-order assertion: the emit must sit between the chartTime
    // reset and beginCount() so plugins capture the wrap at the same
    // moment chartTime jumps back, not after the count-in. The argument
    // to highway.setTime can be `loopA` or `r.to` (post-seek verified
    // position, when the caller has it) — both are valid.
    //
    // startCountIn now has two paths (immediate section-practice entry and
    // the loop-wrap rewind). Assert on the wrap-path trio: the last
    // loop:restart emit sits after the post-seek highway.setTime and before
    // the matching beginCount() call.
    const src = fs.readFileSync(APP_JS, 'utf8');
    const fn = extractFunction(src, START_COUNT_IN_SIG);
    const setTimeMatches = [...fn.matchAll(/highway\.setTime\(\s*[^)]+\)/g)];
    const setTimeIdx = setTimeMatches.length ? setTimeMatches[setTimeMatches.length - 1].index : -1;
    const emitMatches = [...fn.matchAll(/window\.slopsmith\.emit\(\s*['"]loop:restart['"]/g)];
    const emitIdx = emitMatches.length ? emitMatches[emitMatches.length - 1].index : -1;
    const beginCallMatches = [...fn.matchAll(/(?<!function\s)\bbeginCount\s*\(/g)];
    const beginCallIdx = beginCallMatches.length ? beginCallMatches[beginCallMatches.length - 1].index : -1;
    assert.ok(setTimeIdx !== -1, 'highway.setTime call not found');
    assert.ok(emitIdx !== -1, 'loop:restart emit not found');
    assert.ok(beginCallIdx !== -1, 'beginCount() call not found');
    assert.ok(setTimeIdx < emitIdx, 'emit must come after highway.setTime');
    assert.ok(emitIdx < beginCallIdx, 'emit must come before beginCount()');
});
