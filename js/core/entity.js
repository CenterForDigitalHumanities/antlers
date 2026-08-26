/**
 * @module entity Reactive Entity/Annotation objects and render coordination.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * Ported from releases/rc-1.0/js/entities.js with the fixes that killed rc-1.0:
 * objectMatch is defined here (rc-1.0 exported an undefined binding), the
 * worker branches are gone (server-side expansion removed the worker's reason
 * to exist), and Entity extends EventTarget so announcements dispatch on the
 * instance instead of a document shim.  Both read strategies come from
 * ./expand.js — the display merge from forDisplay, the editing parts from
 * clientRead — so this module never issues a request of its own and touches
 * ./rerum.js only for id normalization.
 *
 * EntityMap is render coordination, not a data cache: an identity map keyed by
 * the canonical (https) id form plus one in-flight resolution promise per id,
 * so two consumers of the same deer-id share one object and one fetch (the
 * core-level deer#96 fix) — whichever protocol form each arrived with.  The
 * browser HTTP cache is the only data cache.
 *
 * The two strategies are permanent, not scaffolding: `/expanded` does not carry
 * annotation `@id`s and, by deployment decision, is not going to.  So DEER owns
 * provenance, and the strategy split is how it does.  Two rules keep that from
 * leaking into every call site — reserveEditing() declares the editing ids up
 * front so the upgrade is off the hot path, and Entity#assertionsForEditing is
 * what a form prefills from so it cannot be handed a display document.
 */

import config from './config.js'
import * as rerum from './rerum.js'
import * as expand from './expand.js'
import { applyAssertions } from './assertions.js'

const EntityMap = new Map()
const inFlight = new Map()

/**
 * Ids declared as needing the editing read before anything constructs an Entity
 * for them.  A form that arrives after a view has already begun a display
 * resolution can only recover by throwing that read away: `/expanded` returns
 * the merged document alone, so the RAW entity a client merge needs is not in
 * it and nothing can be topped up.  Declaring the ids at scan time makes the
 * upgrade the rare dynamic-insertion case instead of the ordinary one on any
 * page carrying both a view and a form over the same id.
 */
const editingIds = new Set()

/** The EntityMap key for an id string or a document carrying one. */
const keyOf = (id) => rerum.canonicalId((typeof id === "string") ? id : id?.["@id"] ?? id?.id)

/** The events an Entity announces over its lifetime. */
const LIFECYCLE = ["update", "reload", "complete", "error"]

/**
 * Deep-compare two plain values for structural equality.
 * Lifted from rc-1.0's UTILS.objectMatch — the implementation its entities.js
 * exported without ever defining.
 * @param {Object} o1 first value.
 * @param {Object} o2 second value.
 * @returns {Boolean} whether the two match key-for-key.
 */
function objectMatch(o1 = {}, o2 = {}) {
    // An array and an object with numeric keys produce identical Object.keys, so
    // without this `["a"]` and `{0: "a"}` compare equal — and since this drives
    // the no-op suppression in `set data`, a real change would be swallowed and
    // no `update` would ever announce.
    if (Array.isArray(o1) !== Array.isArray(o2)) { return false }
    const keys1 = Object.keys(o1)
    const keys2 = Object.keys(o2)
    if (keys1.length !== keys2.length) { return false }
    for (const k of keys1) {
        const val1 = o1[k]
        const val2 = o2[k]
        const recurseNeeded = isObject(val1) && isObject(val2)
        if ((recurseNeeded && !objectMatch(val1, val2))
            || (!recurseNeeded && val1 !== val2)) {
            return false
        }
    }
    return true
    function isObject(object) {
        return object != null && typeof object === 'object'
    }
}

/**
 * Freeze an object and everything reachable from it.  Object.freeze is shallow
 * and the interesting mutation is a nested one — `assertions.name.value = …`
 * reaches straight past a shallow freeze.  Freezing before recursing makes this
 * safe on a self-referential document: the cycle is already frozen when it comes
 * back around.
 * @param {any} value the value to freeze, in place.
 * @returns {any} the same value, frozen.
 */
function deepFreeze(value) {
    if (value === null || typeof value !== "object" || Object.isFrozen(value)) { return value }
    Object.freeze(value)
    for (const key of Object.getOwnPropertyNames(value)) { deepFreeze(value[key]) }
    return value
}

/**
 * Protocol-insensitive id comparison — RERUM records ids with whichever
 * protocol the writing proxy sent.
 */
function sameId(a, b) {
    if (typeof a !== "string" || typeof b !== "string") { return false }
    return rerum.canonicalId(a) === rerum.canonicalId(b)
}

/**
 * The stable identity of an annotation across its RERUM versions: the root of
 * its version chain (`__rerum.history.prime`, which is the literal "root" on the
 * original document and the original's @id on every later version).  Keying
 * Annotations by this means an updated annotation REPLACES the version it
 * supersedes instead of accumulating beside it — without this, a read after a
 * write merges the stale value and the new one together.
 * @param {Annotation} annotation the annotation to identify.
 * @returns {String} the version-chain root id, or the annotation's own id for
 * documents that carry no RERUM history.
 */
function versionRootId(annotation) {
    const prime = annotation.data?.__rerum?.history?.prime
    return (typeof prime === "string" && prime !== "root")
        ? rerum.canonicalId(prime)
        : rerum.canonicalId(annotation.id)
}

/**
 * Declare that these ids will be edited, before any of them has been resolved.
 * The elements layer calls this once at scan time with every id its forms
 * carry, so the FIRST read of each is already the editing read and no display
 * read is paid for and discarded.  An Entity already coordinating a reserved id
 * is upgraded here instead of at first form contact — the same cost, paid
 * before a form is waiting on it.
 *
 * Reservation is sticky: an id reserved once resolves as editing for the rest
 * of the session, whatever strategy a later getEntity() asks for.  That is the
 * safe direction — editing is a superset of display, so a view handed an
 * editing Entity renders correctly and merely paid too much, while a form
 * handed a display Entity silently loses every citationSource.
 * @param {...(String|Object|Array)} ids entity URIs, documents carrying one, or
 * arrays thereof.
 * @returns {Number} how many ids were newly reserved.
 */
function reserveEditing(...ids) {
    let reserved = 0
    for (const id of ids.flat(3)) {
        const key = keyOf(id)
        if (typeof key !== "string" || key.length === 0) { continue }
        if (!editingIds.has(key)) { reserved++ }
        editingIds.add(key)
        // Not awaited: reserving is a declaration, not a read.  resolve() never
        // rejects — a failure lands on the Entity as an `error` event.
        const existing = EntityMap.get(key)
        if (existing !== undefined && existing.strategy !== "editing") { existing.upgradeToEditing() }
    }
    return reserved
}

/**
 * The shared way to obtain an Entity: returns the one already coordinating a
 * given id, or constructs (and begins resolving) a new one.
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {Object} options
 *   `strategy`: "display" (default) reads the cacheable server merge and has no
 *     provenance; "editing" reads the client path and carries every annotation
 *     `@id`.  Views take display, forms take editing.  An id passed to
 *     reserveEditing() is constructed as editing whatever this says.
 *   `upgrade`: when an Entity already exists for this id with a weaker strategy
 *     than requested, re-resolve it as "editing" (the default).  Pass false to
 *     take whatever is already coordinating the id without disturbing it.
 * @returns {Entity}
 */
function getEntity(id, { strategy = "display", upgrade = true } = {}) {
    const key = keyOf(id)
    const existing = EntityMap.get(key)
    if (existing) {
        // "editing" is a superset of "display": it carries per-annotation
        // provenance the display read structurally cannot.  So an editing
        // consumer must upgrade a display Entity — being handed one silently is
        // how a form loses its create-vs-update trigger — while a display
        // consumer is satisfied by an editing Entity as it stands.
        if (upgrade && strategy === "editing" && existing.strategy !== "editing") {
            // Already a full re-read, which covers the failed case below too.
            existing.upgradeToEditing()
            return existing
        }
        // A resolution that FAILED is not an answer, and nothing else would
        // ever ask again.  Without this a single transient network blip poisons
        // that id for the life of the page: the failed Entity stays in the map
        // and every later consumer is handed it, error and all.  Concurrent
        // callers do not stampede — resolve() shares one in-flight promise.
        if (existing.settled && existing.error !== undefined) { existing.resolve({ fresh: true }) }
        return existing
    }
    // A reserved id is an editing id no matter who asks for it first.  The view
    // that happens to construct it is satisfied by an editing Entity; the form
    // that reserved it would not be satisfied by a display one.
    const declared = editingIds.has(key) ? "editing" : strategy
    return new Entity((typeof id === "string") ? { id } : id, { strategy: declared })
}

/**
 * Drop all coordination state.  For teardown and tests only — live subscribers
 * keep their Entity references but new consumers will re-resolve.
 */
function clearEntities() {
    EntityMap.clear()
    inFlight.clear()
    editingIds.clear()
}

/**
 * An object described by the documents related to the URI recorded in the
 * `deer-id` attribute.  Constructing one begins resolving it; subscribers
 * listen on the instance for `update`, `reload`, `complete`, and `error`, or
 * call subscribe() to be caught up if resolution has already settled.
 * @class
 */
class Entity extends EventTarget {
    #strategy
    #id
    #assertions
    #settled = false
    #error
    // Bumped whenever the strategy changes under an in-flight resolution, so
    // that resolution can tell its result is no longer wanted.
    #generation = 0
    // True only while an editing resolution is between writing the raw entity
    // and merging its annotations.  See `set data`.
    #merging = false

    /**
     * @param {Object|String} entity object to be described (usually from a JSON-LD
     * document), a JSON string of one, or a bare URI string.
     * @param {Object} options `strategy`, as described on getEntity().
     */
    constructor(entity = {}, { strategy = "display" } = {}) {
        super()
        // accommodate Entity(String) and Entity(Object) or Entity(JSONString)
        if (typeof entity === "string") {
            try {
                entity = JSON.parse(entity)
            } catch (e) {
                entity = { id: entity }
            }
        }
        // `@id` before `id`, the same order keyOf, rerum.idOf, `set data`,
        // Annotation#id and clientRead's isSelf all use.  Reversed, this method
        // checked the map under one key and registered under the other, and a
        // document carrying both — `{"@id": "…", id: 12345}` — was rejected as
        // having no id at all.
        const id = entity["@id"] ?? entity.id // @id is primary key
        if (typeof id !== "string" || id.length === 0) { throw new Error("Entity must have an id") }
        if (EntityMap.has(rerum.canonicalId(id))) { throw new Error(`Entity ${id} already exists. Use getEntity() to share it.`) }
        this.Annotations = new Map()
        this.#strategy = (strategy === "editing") ? "editing" : "display"
        this.#id = id
        this.data = entity
    }

    /** "display" or "editing" — which read path resolves this Entity. */
    get strategy() {
        return this.#strategy
    }

    /** True once a resolution has finished, successfully or not. */
    get settled() {
        return this.#settled
    }

    /**
     * What the last resolution failed with, or undefined if it succeeded.
     * Read with `settled` to tell "failed" from "still resolving".
     */
    get error() {
        return this.#error
    }

    /**
     * This Entity's URI.  Identity is Entity state, not document content: the
     * stored document is left exactly as RERUM sent it, and `@id` or `id` is
     * read from it here — the same way Annotation#id does.
     */
    get id() {
        return this.#id
    }

    get data() {
        return this._data
    }

    /**
     * The DEER-shaped view of this Entity.  Memoized: recomputing it means a
     * structuredClone and a full merge, and `set data`, every attachment, and
     * every subscriber reading `detail.payload` would each pay for one.
     * Invalidated by anything that changes the document or its annotations.
     */
    get assertions() {
        if (this.#assertions === undefined) {
            // The display read comes back already shaped by expand.forDisplay
            // and has no annotations to merge; only the editing read does.
            // Cloned, not aliased: the display read is already shaped, so
            // returning _data itself would hand out the Entity's own document.
            // The editing branch already returns a fresh object.
            //
            // Frozen because the memo is SHARED, which the clone alone does not
            // address: every subscriber — including the ones subscribe() catches
            // up after settling — receives this same object as detail.payload,
            // so one of them mutating it corrupts the value all the others were
            // given.  Cloning per read would fix that too, but it defeats the
            // memo, which exists because recomputing means a structuredClone and
            // a full merge on every read.  Freezing keeps one object and turns
            // the corruption into a throw.
            this.#assertions = deepFreeze((this.#strategy === "display")
                ? structuredClone(this._data)
                : applyAssertions(this._data, [...this.Annotations.values()].map(a => a.data)))
        }
        return this.#assertions
    }

    /**
     * The DEER-shaped view a form prefills from, guaranteed to carry
     * `source.citationSource` on every merged value.
     *
     * A form holding an Entity must prefill through THIS, never by reading
     * `assertions` directly: that returns whatever strategy the Entity happens
     * to be on, and a display document has no provenance at all — a form
     * prefilled from one POSTs a duplicate assertion on save instead of
     * updating the annotation already there.  The failure is silent and it
     * corrupts data, so the door is closed here: this method upgrades the
     * Entity before it answers and awaits the read.  (A form that does not want
     * Entity coordination reads expand.forEditing instead, which is safe by
     * construction — it has no strategy to be wrong about.)
     * @returns {Promise<Object>} the shaped entity, with full provenance.
     * @throws whatever the resolution failed with — unlike the `error` event, a
     * form awaiting a prefill must not proceed as though it had one.
     */
    async assertionsForEditing() {
        if (this.#strategy !== "editing" && config.DEBUG) {
            console.warn(`${this.#id}: upgraded to the editing read on demand, discarding a display read already paid for. Reserve the ids your forms carry with reserveEditing() at scan time so the first read is the right one.`)
        }
        await this.upgradeToEditing()
        if (this.#error !== undefined) { throw this.#error }
        return this.assertions
    }

    set data(entity) {
        // Adopt a shallow copy so the caller's object is never mutated.
        const candidate = { ...entity }
        if (objectMatch(this._data, candidate)) {
            // no-op suppression: identical data must not re-announce (render loop guard)
            return
        }
        const isFirstData = this._data === undefined
        const oldId = this.#id
        this._data = candidate
        this.#assertions = undefined
        this.#id = candidate["@id"] ?? candidate.id ?? oldId
        // When resolution changes the id, the previous key is left pointing at
        // this same Entity on purpose — consumers that arrived with the old URI
        // keep resolving to it rather than constructing a second object.
        EntityMap.set(rerum.canonicalId(this.#id), this)
        // Silent while an editing resolution is mid-merge.  The raw entity
        // without its annotations is not a smaller version of the answer, it is
        // a document with NO PROVENANCE IN IT — same DEER shape, fewer keys, no
        // `source.citationSource` anywhere — and nothing on the event or the
        // Entity distinguishes it from a finished one (`settled` is false for
        // both).  A form prefilling on that `update` POSTs a duplicate
        // assertion on every save instead of updating the annotation already
        // there: silent corruption, which is what this rewrite exists to end.
        // #findAssertions announces once, after the merge.
        if (!this.#merging) { this.#announce("update", this.assertions) }
        if (isFirstData) {
            // Construction begins resolution.  That is a first render, not a
            // reload, and the two must stay distinguishable.
            this.resolve()
            return
        }
        if (!sameId(oldId, this.#id)) {
            // The id moved under us: re-resolve under the new URI and tell
            // subscribers to repaint — but only if that resolution produced
            // something.  A failed resolve leaves the stub behind, and painting
            // it over good data is worse than not repainting at all.
            // The shaped document, matching what `update` carries.  subscribe()
            // hands every lifecycle event to one handler, so a payload that is
            // sometimes an Entity and sometimes a document means any consumer
            // reading `detail.payload.name` works for one event and breaks on
            // the other.
            this.resolve().then(() => { if (this.#error === undefined) { this.#announce("reload", this.assertions) } })
        }
    }

    /**
     * Re-resolve this Entity through the editing path, so its values carry the
     * annotation `@id`s a form needs.  A no-op when it is already an editing
     * Entity, apart from awaiting a resolution already under way.
     *
     * Prefer reserveEditing() at scan time: reaching here means a display read
     * was paid for and is now being discarded.
     * @returns {Promise<void>} settles when the re-resolution has been applied.
     */
    upgradeToEditing() {
        if (this.#strategy === "editing") {
            // Already on the right path.  resolve() would issue a whole new
            // read of a settled Entity for nothing; only an unsettled one has a
            // resolution worth waiting on, and resolve() shares that promise.
            return this.#settled ? Promise.resolve() : this.resolve()
        }
        this.#strategy = "editing"
        this.#assertions = undefined
        this.#settled = false
        // A display resolution may already be in flight.  Nothing cancels a
        // fetch, so mark its result unwanted: without this it lands last often
        // enough to matter, writes its SHAPED document into _data, and the
        // editing merge then runs on top of the server's merge — every value
        // duplicated, half of them with no citationSource, which makes the next
        // form save POST a new annotation instead of updating.
        this.#generation++
        // Nothing from the display read is reusable — it has no provenance at
        // all — so this is a full re-read, not a top-up.
        return this.resolve({ fresh: true })
    }

    /**
     * Subscribe to this Entity's whole lifecycle.  A subscriber that arrives
     * after resolution settled — an element upgraded later in the document,
     * sharing a deer-id with an earlier one — is caught up immediately, because
     * the events it needed have already fired.  Without this, only the first of
     * N elements on one deer-id ever renders.
     * @param {Function} handler receives the same CustomEvents addEventListener would.
     * @returns {Function} call to unsubscribe.
     */
    subscribe(handler) {
        for (const action of LIFECYCLE) { this.addEventListener(action, handler) }
        if (this.#settled) {
            if (this.#error === undefined) {
                handler(this.#event("update", this.assertions))
                // Replay `complete` too.  An element that renders on it would
                // otherwise render only for the first subscriber — which is the
                // several-elements-on-one-deer-id case this Map exists for.
                handler(this.#event("complete"))
            } else {
                handler(this.#event("error", this.#error))
            }
        }
        return () => { for (const action of LIFECYCLE) { this.removeEventListener(action, handler) } }
    }

    /**
     * Hold an annotation against this Entity, keyed by version-chain root so a
     * new version replaces the one it supersedes.
     * @param {Annotation} annotation the annotation to hold.  Its id may be
     * recorded as `@id` or `id`; Annotation#id reads either.
     * @returns {Boolean} whether it was taken — false for an annotation with no
     * id, which has no stable identity to key on.
     */
    attachAnnotation(annotation) {
        if (annotation.id === undefined || annotation.id === null) { return false }
        this.Annotations.set(versionRootId(annotation), annotation)
        this.#assertions = undefined
        return true
    }

    /**
     * Resolve this entity through its strategy's read path.  Concurrent calls
     * for the same id share one in-flight promise — two consumers of the same
     * deer-id cost one round trip.
     * @param {Object} options `fresh: true` busts the HTTP cache (read-after-write).
     * @returns {Promise<void>} settles when resolution has been applied.  It
     * does not reject: a failure is announced as an `error` event and left on
     * the Entity, so subscribers see it whenever they arrive.
     */
    resolve({ fresh = false } = {}) {
        // Keyed by strategy as well as id: an editing caller must never be
        // handed a display resolution's promise, which resolves to a document
        // carrying no provenance at all.
        const key = `${this.#strategy}:${rerum.canonicalId(this.#id)}`
        const pending = inFlight.get(key)
        // A pending non-fresh resolution cannot satisfy a fresh request —
        // read-after-write must never be served a stale in-flight promise.
        if (pending && (pending.fresh || !fresh)) { return pending.promise }
        // Starting a new resolution retires every older one.  The only way to
        // reach here with one already in flight is a fresh request overtaking a
        // non-fresh one, so newest-started is always the one that should win.
        // Without this the older read lands second, writes its pre-write
        // document into _data and announces `update` with it — painting stale
        // data over the save that the fresh read was issued to pick up.
        // Must come AFTER the early return above: bumping before it would
        // invalidate the very resolution that return is handing back.
        //
        // A caller awaiting the RETIRED promise now settles before the new data
        // lands.  upgradeToEditing() already had that property and subscribe()
        // covers it — `complete` fires when the winning resolution applies.
        this.#generation++
        // Retrying a FAILED resolution un-settles it, so a subscriber arriving
        // mid-retry waits for the real answer.  Left settled, subscribe() would
        // catch it up with the stub the failure left behind and announce
        // `complete` over it — an empty entity presented as a finished one.
        if (this.#error !== undefined) { this.#settled = false }
        const promise = this.#resolveURI(fresh)
            .finally(() => { if (inFlight.get(key)?.promise === promise) { inFlight.delete(key) } })
        inFlight.set(key, { promise, fresh })
        return promise
    }

    /**
     * Take the annotation documents this Entity's read returned.  Constructing
     * an Annotation self-wires it onto every Entity it targets, so attachment
     * is a side effect; attaching explicitly as well is what makes the count
     * honest, because attachAnnotation reports whether THIS Entity could key
     * on it.  Documents are already filtered to Annotation types by
     * expand.clientRead.
     *
     * The read is AUTHORITATIVE: it returns every annotation this deployment has
     * against the entity, so the Map is rebuilt rather than added to.  Anything
     * held from an earlier read that this one did not return has been deleted,
     * retargeted, or has stopped matching the generator filter, and merging it
     * again resurrects a value the data no longer asserts.  Version-chain keying
     * (see versionRootId) already stops a SUPERSEDED annotation accumulating
     * beside its replacement; this is the removal half of the same problem.
     *
     * Clearing before the loop, never after: constructing an Annotation
     * self-wires it onto every Entity it targets, so the annotations this read
     * returned re-attach themselves during the loop.  A multi-target annotation
     * attached here by ANOTHER entity's read is dropped, which is correct — this
     * entity's own query matches on every target key, so a live one comes back
     * in `annotations` anyway.  The exception is a read truncated at the page
     * limit, which expand.clientRead already warns about.
     * @param {Array<Object>} annotations annotation documents targeting this id.
     */
    #findAssertions = (annotations) => {
        this.Annotations = new Map()
        for (const anno of annotations) {
            this.attachAnnotation(new Annotation(anno))
        }
        // Unconditional, and it has to be: `set data` stays silent through the
        // merge now, so this is the ONLY `update` an editing resolution emits.
        // The old guard ("did anything attach, did the count move") also missed
        // two real cases — a read whose annotations are unchanged but whose
        // ENTITY document changed, and a read that returns no annotations for
        // an entity that had none, which still has to tell its subscribers the
        // resolution produced something.
        this.#announce("update", this.assertions)
        this.#settled = true
        this.#announce("complete")
    }

    #resolveURI = async (fresh) => {
        // Captured before the first await.  A strategy change while this is in
        // flight bumps #generation, and everything below then belongs to a
        // resolution nobody wants — writing its result would clobber the newer
        // one.  Reading #strategy once also keeps the branch and its result in
        // agreement, which matters because the two produce different documents:
        // display is already shaped, editing is raw.
        const generation = this.#generation
        const strategy = this.#strategy
        this.#error = undefined
        try {
            if (strategy === "display") {
                // One cacheable read, no provenance.  forDisplay shapes the
                // result itself, so there are no Annotations to attach.
                const resolved = await expand.forDisplay(this.#id, { fresh })
                if (generation !== this.#generation) { return }
                this.data = resolved
                this.#settled = true
                this.#announce("complete")
                return
            }
            // The editing read belongs to expand.clientRead; Entity holds the
            // parts it returns rather than re-deriving them, so there is one
            // implementation of the provenance-critical path, not two.
            const { entity, annotations } = await expand.clientRead(this.#id, { fresh })
            if (generation !== this.#generation) { return }
            // Held across `set data` so it cannot announce a half-merged
            // document; #findAssertions announces the finished one.  try/finally
            // because a throw out of `set data` must not leave the flag set and
            // silence every later announcement on this Entity.
            this.#merging = true
            try {
                this.data = entity
            } finally {
                this.#merging = false
            }
            this.#findAssertions(annotations)
        } catch (err) {
            if (generation !== this.#generation) { return }
            this.#fail(err)
        }
    }

    #fail = (err) => {
        this.#error = err
        this.#settled = true
        this.#announce("error", err)
    }

    #event = (action, payload) => new CustomEvent(action, {
        detail: {
            action,
            id: this.#id,
            payload
        }
    })

    #announce = (action, payload) => {
        this.dispatchEvent(this.#event(action, payload))
    }
}

/**
 * An object describing a document related to the URI it targets.  Constructing
 * one attaches it to every Entity it targets (self-wiring).
 * @class
 */
class Annotation {
    /**
     * @param {Object} annotation document asserting a value or relationship.
     */
    constructor(annotation) {
        this.data = annotation
        this.#registerTargets()
    }

    get id() {
        return this.data["@id"] ?? this.data.id // id is primary key
    }

    // Self-wiring: an id not already coordinated gets an Entity, and a new
    // Entity begins resolving itself.  An annotation with several targets
    // therefore pulls its other targets (and their annotations) into memory as
    // a side effect of resolving the first one.
    #registerTargets = () => {
        let targets = this.data.target
        if (!Array.isArray(targets)) { targets = [targets] }
        for (let target of targets) {
            if (!target) { continue }
            target = target["@id"] ?? target.id ?? ((typeof target === "string") ? target : undefined)
            if (!target) { continue }
            // A backstop, not an expected case.  DEER forms annotate the RERUM
            // entity they just created, and expand.clientRead now hands over
            // only annotations this deployment wrote, so every target reaching
            // here should already be RERUM-hosted.  Should is not is: the reads
            // REFUSE a non-RERUM id, so an anomalous target would otherwise
            // construct an Entity that can only fail — a dead EntityMap key and
            // a spurious `error` event for data nobody asked to load.  The
            // Annotation is still held by the Entity whose read produced it.
            if (!rerum.isRerumId(target)) {
                if (config.DEBUG) { console.warn(`Annotation ${this.id} targets ${target}, which is outside RERUM. Not resolving it; the annotation is still attached to its RERUM targets.`) }
                continue
            }
            // Holding Annotation objects only matters to the editing path, so a
            // target discovered this way is created as an editing Entity — but
            // upgrade is off, because a view rendering elsewhere on the page
            // should not be re-read out from under itself as a side effect.
            getEntity(target, { strategy: "editing", upgrade: false }).attachAnnotation(this)
        }
    }
}

export { EntityMap, Entity, Annotation, objectMatch, getEntity, reserveEditing, clearEntities }
