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
 */

import * as rerum from './rerum.js'
import * as expand from './expand.js'
import { applyAssertions } from './assertions.js'

const EntityMap = new Map()
const inFlight = new Map()

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
 * The shared way to obtain an Entity: returns the one already coordinating a
 * given id, or constructs (and begins resolving) a new one.
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {Object} options
 *   `strategy`: "display" (default) reads the cacheable server merge and has no
 *     provenance; "editing" reads the client path and carries every annotation
 *     `@id`.  Views take display, forms take editing.
 *   `lazy`: editing strategy only — resolve with a direct GET plus a separate
 *     targeting-annotation query instead of the single compound query.
 *   `upgrade`: when an Entity already exists for this id with a weaker strategy
 *     than requested, re-resolve it as "editing" (the default).  Pass false to
 *     take whatever is already coordinating the id without disturbing it.
 * @returns {Entity}
 */
function getEntity(id, { lazy = false, strategy = "display", upgrade = true } = {}) {
    const key = rerum.canonicalId((typeof id === "string") ? id : id?.["@id"] ?? id?.id)
    const existing = EntityMap.get(key)
    if (existing) {
        // "editing" is a superset of "display": it carries per-annotation
        // provenance the display read structurally cannot.  So an editing
        // consumer must upgrade a display Entity — being handed one silently is
        // how a form loses its create-vs-update trigger — while a display
        // consumer is satisfied by an editing Entity as it stands.
        if (upgrade && strategy === "editing" && existing.strategy !== "editing") { existing.upgradeToEditing() }
        return existing
    }
    return new Entity((typeof id === "string") ? { id } : id, { lazy, strategy })
}

/**
 * Drop all coordination state.  For teardown and tests only — live subscribers
 * keep their Entity references but new consumers will re-resolve.
 */
function clearEntities() {
    EntityMap.clear()
    inFlight.clear()
}

/**
 * An object described by the documents related to the URI recorded in the
 * `deer-id` attribute.  Constructing one begins resolving it; subscribers
 * listen on the instance for `update`, `reload`, `complete`, and `error`, or
 * call subscribe() to be caught up if resolution has already settled.
 * @class
 */
class Entity extends EventTarget {
    #isLazy
    #strategy
    #id
    #assertions
    #settled = false
    #error
    // Bumped whenever the strategy changes under an in-flight resolution, so
    // that resolution can tell its result is no longer wanted.
    #generation = 0

    /**
     * @param {Object|String} entity object to be described (usually from a JSON-LD
     * document), a JSON string of one, or a bare URI string.
     * @param {Object} options `strategy` and `lazy`, as described on getEntity().
     */
    constructor(entity = {}, { lazy = false, strategy = "display" } = {}) {
        super()
        // accommodate Entity(String) and Entity(Object) or Entity(JSONString)
        if (typeof entity === "string") {
            try {
                entity = JSON.parse(entity)
            } catch (e) {
                entity = { id: entity }
            }
        }
        const id = entity.id ?? entity["@id"] // id is primary key
        if (typeof id !== "string" || id.length === 0) { throw new Error("Entity must have an id") }
        if (EntityMap.has(rerum.canonicalId(id))) { throw new Error(`Entity ${id} already exists. Use getEntity() to share it.`) }
        this.Annotations = new Map()
        this.#isLazy = Boolean(lazy)
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
            // returning _data itself would let any subscriber mutating
            // detail.payload corrupt the Entity for every other subscriber.
            // The editing branch already returns a fresh object.
            this.#assertions = (this.#strategy === "display")
                ? structuredClone(this._data)
                : applyAssertions(this._data, [...this.Annotations.values()].map(a => a.data))
        }
        return this.#assertions
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
        this.#announce("update", this.assertions)
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
            this.resolve().then(() => { if (this.#error === undefined) { this.#announce("reload", this) } })
        }
    }

    /**
     * Re-resolve this Entity through the editing path, so its values carry the
     * annotation `@id`s a form needs.  A no-op when it is already an editing
     * Entity, apart from ensuring a resolution is under way.
     * @returns {Promise<void>} settles when the re-resolution has been applied.
     */
    upgradeToEditing() {
        if (this.#strategy === "editing") { return this.resolve() }
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
     * @param {Array<Object>} annotations annotation documents targeting this id.
     */
    #findAssertions = (annotations) => {
        let attached = 0
        for (const anno of annotations) {
            if (this.attachAnnotation(new Annotation(anno))) { attached++ }
        }
        if (attached) { this.#announce("update", this.assertions) }
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
            const { entity, annotations } = await expand.clientRead(this.#id, { fresh, lazy: this.#isLazy })
            if (generation !== this.#generation) { return }
            this.data = entity
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
            target = target.id ?? target["@id"] ?? ((typeof target === "string") ? target : undefined)
            if (!target) { continue }
            // Holding Annotation objects only matters to the editing path, so a
            // target discovered this way is created as an editing Entity — but
            // upgrade is off, because a view rendering elsewhere on the page
            // should not be re-read out from under itself as a side effect.
            getEntity(target, { lazy: true, strategy: "editing", upgrade: false }).attachAnnotation(this)
        }
    }
}

export { EntityMap, Entity, Annotation, objectMatch, getEntity, clearEntities }
