/**
 * @module entity Reactive Entity/Annotation objects and render coordination.
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * Ported from releases/rc-1.0/js/entities.js.
 */

import config from './config.js'
import * as rerum from './rerum.js'
import * as expand from './expand.js'
import { applyAssertions, markShaped, shapeValues } from './assertions.js'

const EntityMap = new Map()
const inFlight = new Map()

/**
 * Ids declared as needing the editing read before anything constructs an Entity
 * for them.  A form that arrives after a view has already begun a display
 * resolution can only recover by throwing that read away.
 */
const editingIds = new Set()

/** The EntityMap key for an id string or a document carrying one. */
const keyOf = (id) => rerum.canonicalId((typeof id === "string") ? id : id?.["@id"] ?? id?.id)

/**
 * The second EntityMap key a record with a RERUM Slug answers to: the shared
 * rerum.slugUriOf construction, canonicalized the way every map key is.
 *
 * @param {Object} doc a resolved entity document.
 * @returns {String|undefined} the canonical slug URI, or undefined without one.
 */
const slugAliasOf = (doc) => rerum.canonicalId(rerum.slugUriOf(doc))

/** The events an Entity announces over its lifetime. */
const LIFECYCLE = ["update", "reload", "complete", "error"]

/**
 * Deep-compare two plain values for structural equality.
 *
 * @param {Object} o1 first value.
 * @param {Object} o2 second value.
 * @returns {Boolean} whether the two match key-for-key.
 */
function objectMatch(o1 = {}, o2 = {}) {
    // `["a"]` and `{0: "a"}` produce identical Object.keys.  This drives the
    // no-op suppression in `set data`, so without the guard a real change is
    // swallowed and no `update` ever announces.
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
 * and `assertions.name.value = …` reaches straight past a shallow freeze.
 * Freezing before recursing makes this safe on a self-referential document: the cycle 
 * is already frozen when it comes back around.
 *
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
 * its version chain Keying Annotations by this means an updated annotation
 * REPLACES the version it supersedes instead of accumulating beside it.
 * Without this, a read after a write merges the stale value and the new one together.
 *
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
 *
 * Reservation is sticky: an id reserved once resolves as editing for the rest
 * of the session, whatever strategy a later getEntity() asks for.  That is the
 * safe direction — editing is a superset of display, so a view handed an
 * editing Entity renders correctly and merely paid too much, while a form
 * handed a display Entity silently loses every citationSource.
 *
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
 *
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
    // Refused here rather than left to the constructor, so all three ways of
    // arriving without an id fail identically.
    if (typeof key !== "string" || key.length === 0) { throw new Error("Entity must have an id") }
    const existing = EntityMap.get(key)
    if (existing) {
        // An editing consumer must upgrade a display Entity — being handed one silently
        // is how a form loses its create-vs-update trigger
        if (upgrade && strategy === "editing" && existing.strategy !== "editing") {
            // Already a full re-read, which covers the failed case below too.
            existing.upgradeToEditing()
            return existing
        }
        // A resolution that FAILED is not an answer, and nothing else would
        // ever ask again.  Without this a single transient network blip poisons
        // that id for the life of the page.
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
 *
 */
function clearEntities() {
    for (const held of new Set(EntityMap.values())) { held.retire() }
    EntityMap.clear()
    inFlight.clear()
    editingIds.clear()
    rerum.clearStale()
    expand.clearWarnings()
}

/**
 * An object described by the documents related to the URI recorded in the
 * `deer-id` attribute.  Constructing one begins resolving it; subscribers
 * listen on the instance for `update`, `reload`, `complete`, and `error`, or
 * call subscribe() to be caught up if resolution has already settled.
 *
 * An Entity may end up DELEGATING to another one that turned out to coordinate
 * the same record (see #adopt).  Every public read here goes through a getter
 * for that reason: an adopted Entity keeps working for whoever already holds it
 * while owning no state of its own.  Nothing outside this class needs to know
 * which of the two it is holding.
 *
 * @class
 */
class Entity extends EventTarget {
    #strategy
    // Which read path produced the document currently in _data, as opposed to
    // #strategy, which is the path this Entity is HEADING for.
    #dataStrategy
    #id
    #assertions
    #settled = false
    #error
    // Bumped whenever the strategy changes under an in-flight resolution, so
    // that resolution can tell its result is no longer wanted.
    #generation = 0
    // True only while an editing resolution is between writing the raw entity
    // and merging its annotations..
    #merging = false
    // True only while a resolution is writing its own result into _data, which
    // is what tells `set data` an id change came from the read rather than from
    // a consumer reassigning the document.
    #applying = false
    // Annotations is a PUBLIC read surface but a private field, so an adopted
    // Entity can delegate it.  Internal writers use this,
    #annotations
    // The Entity this one deferred to, if it lost an identity collision.  See
    // #adopt.  Every read on this object delegates to it from then on.
    #adopted
    // Tears down the event forwarding #adopt set up, or undefined when this
    // Entity is not currently forwarding.
    #stopForwarding
    // Every EntityMap key this Entity registered under.  A record is reached by
    // more than one URI and #release has to remove ALL of them -- a key
    // left pointing at a released Entity is worse than no release at all.
    #mapKeys = new Set()
    // Live subscribe() calls.  The map holds an Entity forever otherwise: it is
    // render coordination, not a cache, so an Entity nothing is listening to has
    // no coordination left to do.
    #subscribers = 0
    // Whether subscribe() has EVER been called.  #register consults both: a
    // released Entity (had subscribers, has none) must stay out of the map,
    // while a never-subscribed one still registers.
    #everSubscribed = false

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
        const id = entity["@id"] ?? entity.id // @id is primary key
        if (typeof id !== "string" || id.length === 0) { throw new Error("Entity must have an id") }
        if (EntityMap.has(rerum.canonicalId(id))) { throw new Error(`Entity ${id} already exists. Use getEntity() to share it.`) }
        this.#annotations = new Map()
        this.#strategy = (strategy === "editing") ? "editing" : "display"
        this.#id = id
        this.data = entity
    }

    /**
     * The annotations held against this Entity, keyed by version-chain root.
     * Empty on the display strategy by design — see attachAnnotation.
     */
    get Annotations() {
        return this.#adopted?.Annotations ?? this.#annotations
    }

    /** "display" or "editing" — which read path resolves this Entity. */
    get strategy() {
        return this.#adopted?.strategy ?? this.#strategy
    }

    /** True once a resolution has finished, successfully or not. */
    get settled() {
        return (this.#adopted !== undefined) ? this.#adopted.settled : this.#settled
    }

    /**
     * What the last resolution failed with, or undefined if it succeeded.
     * Read with `settled` to tell "failed" from "still resolving".
     */
    get error() {
        return (this.#adopted !== undefined) ? this.#adopted.error : this.#error
    }

    /**
     * This Entity's URI.  Identity is Entity state, not document content: the
     * stored document is left exactly as RERUM sent it, and `@id` or `id` is
     * read from it here.
     */
    get id() {
        return this.#adopted?.id ?? this.#id
    }

    get data() {
        return (this.#adopted !== undefined) ? this.#adopted.data : this._data
    }

    /**
     * The DEER-shaped view of this Entity.  Memoized.
     * Invalidated by anything that changes the document or its annotations.
     */
    get assertions() {
        if (this.#adopted !== undefined) { return this.#adopted.assertions }
        if (this.#dataStrategy !== undefined && this.#dataStrategy !== this.#strategy) {
            const why = (this.#error === undefined)
                ? `the ${this.#dataStrategy} read is being upgraded to ${this.#strategy}`
                : `the upgrade from the ${this.#dataStrategy} read to ${this.#strategy} failed (${this.#error.message})`
            throw new Error(`${this.#id}: assertions are not available -- ${why}. Await assertionsForEditing(), or render on the 'update'/'complete' events.`)
        }
        if (this.#assertions === undefined) {
            this.#assertions = deepFreeze(markShaped(structuredClone((this.#strategy === "display")
                ? shapeValues(this._data)
                : applyAssertions(this._data, [...this.#annotations.values()].map(a => a.data)))))
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
     * updating the annotation already there.
     */
    async assertionsForEditing() {
        if (this.#adopted !== undefined) { return this.#adopted.assertionsForEditing() }
        if (this.#strategy !== "editing" && config.DEBUG) {
            console.warn(`${this.#id}: upgraded to the editing read on demand, discarding a display read already paid for. Reserve the ids your forms carry with reserveEditing() at scan time so the first read is the right one.`)
        }
        await this.upgradeToEditing()
        if (this.#error !== undefined) { throw this.#error }
        return this.assertions
    }

    set data(entity) {
        // An adopted Entity owns no document.  Assigning through it is assigning
        // to the record, which the incumbent coordinates.
        if (this.#adopted !== undefined) {
            this.#adopted.data = entity
            return
        }
        // Adopt a shallow copy so the caller's object is never mutated.
        const candidate = { ...entity }
        if (objectMatch(this._data, candidate)) {
            // no-op suppression: identical data must not re-announce (render loop guard)
            return
        }
        const isFirstData = this._data === undefined
        const oldId = this.#id
        const nextId = candidate["@id"] ?? candidate.id ?? oldId
        const canonical = rerum.canonicalId(nextId)
        const incumbent = EntityMap.get(canonical)
        if (incumbent !== undefined && incumbent !== this) {
            this.#adopt(incumbent)
            return
        }
        this._data = candidate
        this.#assertions = undefined
        this.#id = nextId
        if (!this.#applying) { this.#dataStrategy = undefined }
        this.#register(canonical)
        // A record answering to a Slug answers to TWO URIs, and RERUM treats
        // them as one record.  Registering the alias makes this map agree.
        const slugUri = slugAliasOf(candidate)
        if (slugUri !== undefined) { this.#register(slugUri) }
        if (!this.#merging) { this.#announceShaped("update") }
        if (isFirstData) {
            // Construction begins resolution.  That is a first render, not a
            // reload, and the two must stay distinguishable.
            this.resolve()
            return
        }
        if (!sameId(oldId, this.#id) && !this.#applying) {
            // Not while a resolution is applying its own result.  A record with
            // a RERUM Slug answers to two URIs, so a read addressed by the slug
            // comes back carrying the record's own `@id` and lands here.
            //
            // Re-resolve under the new URI and tell subscribers to repaint — but
            // only if that resolution produced something.  A failed resolve
            // leaves the stub behind, and painting it over good data is worse
            // than not repainting at all.
            this.resolve().then(() => { if (this.error === undefined) { this.#announceShaped("reload") } })
        }
    }

    /**
     * Claim an EntityMap key for this Entity and remember that it did.  A record
     * is reached by more than one URI, and #release has to give every one of them
     * back — a key left pointing at a released Entity is worse than no release.
     *
     * @param {String} key the canonical map key.
     */
    #register = (key) => {
        this.#mapKeys.add(key)
        // A released Entity must not re-claim map slots.  Unsubscribing does
        // not cancel an in-flight read.
        if (this.#everSubscribed && this.#subscribers === 0) { return }
        EntityMap.set(key, this)
    }

    /**
     * Defer to the Entity already coordinating this record.
     *
     * @param {Entity} incumbent the Entity that holds the record's key.
     */
    #adopt = (incumbent) => {
        this.#adopted = incumbent
        // Re-point, not delete: a consumer that arrived by the URI this Entity
        // was constructed with (the Slug, typically) must reach the survivor.
        // The incumbent takes ownership so its own #release gives them back.
        for (const key of this.#mapKeys) {
            if (EntityMap.get(key) === this) { EntityMap.set(key, incumbent) }
            incumbent.#mapKeys.add(key)
        }
        this.#mapKeys.clear()
        // This Entity's live subscribers are consumers of the RECORD, and the
        // record is the incumbent's to coordinate now, so their count moves
        // with them.
        if (this.#subscribers > 0) {
            incumbent.#subscribers += this.#subscribers
            incumbent.#everSubscribed = true
            this.#subscribers = 0
        }
        // This Entity's own in-flight resolution is now redundant work whose
        // result must not be applied.  Bumping the generation retires it through
        // the checks #resolveURI already makes.
        this.#generation++
        this._data = undefined
        this.#assertions = undefined
        this.#annotations = new Map()
        this.#forwardFrom(incumbent)
    }

    /**
     * Re-dispatch another Entity's lifecycle on this one.
     *
     * @param {Entity} incumbent the Entity to forward from.
     */
    #forwardFrom = (incumbent) => {
        this.#stopForwarding = incumbent.#listen((ev) => {
            this.dispatchEvent(new CustomEvent(ev.detail.action, { detail: { ...ev.detail } }))
        })
    }

    /**
     * Give up this Entity's map keys once nothing is listening to it.
     */
    #release = () => {
        for (const key of this.#mapKeys) {
            if (EntityMap.get(key) === this) { EntityMap.delete(key) }
        }
        // #mapKeys is kept, not cleared: #reclaim restores the keys that are
        // still free if this Entity is subscribed to again, which is the
        // ordinary custom-element disconnect/reconnect cycle.
        if (this.#stopForwarding !== undefined) {
            this.#stopForwarding()
            this.#stopForwarding = undefined
        }
    }

    /**
     * Re-enter the map after a #release, for a re-subscribed Entity.  Only
     * reached when this Entity is not adopted — subscribe() delegates an
     * adopted one to its incumbent before it gets here.
     */
    #reclaim = () => {
        for (const key of this.#mapKeys) {
            const holder = EntityMap.get(key)
            if (holder !== undefined && holder !== this) {
                this.#adopt(holder)
                return
            }
        }
        for (const key of this.#mapKeys) {
            if (!EntityMap.has(key)) { EntityMap.set(key, this) }
        }
    }

    /**
     * Announce with the shaped document, without letting the shaping throw out
     * of a property setter. A document this Entity cannot shape is afailed resolution
     * like any other, so it is reported as one.
     *
     * @param {String} action the lifecycle event to announce.
     */
    #announceShaped = (action) => {
        let payload
        try {
            payload = this.assertions
        } catch (err) {
            this.#fail(err)
            return
        }
        this.#announce(action, payload)
    }

    /**
     * Re-resolve this Entity through the editing path, so its values carry the
     * annotation `@id`s a form needs.  A no-op when it is already an editing
     * Entity, apart from awaiting a resolution already under way.
     *
     * @returns {Promise<void>} settles when the re-resolution has been applied.
     */
    upgradeToEditing() {
        if (this.#adopted !== undefined) { return this.#adopted.upgradeToEditing() }
        if (this.#strategy === "editing") {
            return (this.#settled && this.#error === undefined)
                ? Promise.resolve()
                : this.resolve({ fresh: this.#error !== undefined })
        }
        this.#strategy = "editing"
        this.#assertions = undefined
        this.#settled = false
        this.#generation++
        // Nothing from the display read is reusable — it has no provenance at
        // all — so this is a full re-read, not a top-up.
        return this.resolve({ fresh: true })
    }

    /**
     * Discard whatever read is in flight on this Entity, so its result is never
     * applied.  Bumping the generation retires it through the checks
     * #resolveURI already makes.
     *
     * For teardown only — clearEntities() calls it.  The Entity is not failed
     * and not destroyed: whoever still holds a reference keeps a working object
     * and can resolve() it again.
     */
    retire() {
        if (this.#adopted !== undefined) { this.#adopted.retire(); return }
        this.#generation++
    }

    /**
     * Subscribe to this Entity's whole lifecycle.  A subscriber that arrives
     * after resolution settled — an element upgraded later in the document,
     * sharing a deer-id with an earlier one — is caught up immediately, because
     * the events it needed have already fired.  Without this, only the first of
     * N elements on one deer-id ever renders.
     *
     * @param {Function} handler receives the same CustomEvents addEventListener would.
     * @returns {Function} call to unsubscribe.
     */
    subscribe(handler) {
        if (this.#adopted !== undefined) { return this.#adopted.subscribe(handler) }
        if (this.#subscribers === 0) { this.#reclaim() }
        // #reclaim adopts the Entity that claimed this one's keys while it was
        // released, so the delegation above has to be re-checked.
        if (this.#adopted !== undefined) { return this.#adopted.subscribe(handler) }
        this.#everSubscribed = true
        this.#subscribers++
        const stop = this.#listen(handler)
        let done = false
        return () => {
            if (done) { return }
            done = true
            stop()
            const owner = this.#adopted ?? this
            owner.#subscribers--
            if (owner.#subscribers === 0) { owner.#release() }
        }
    }

    /**
     * Register a handler on the whole lifecycle and catch it up, WITHOUT
     * counting it as a subscriber.  #adopt forwards through this: an adopter is
     * not a consumer, and counting it would pin the incumbent in the map for as
     * long as the adopter existed.
     *
     * Reads go through the public getters so an adopted Entity catches up from
     * the record's real state rather than from its own empty shell.
     * @param {Function} handler receives the same CustomEvents addEventListener would.
     *
     * @returns {Function} call to detach.
     */
    #listen = (handler) => {
        for (const action of LIFECYCLE) { this.addEventListener(action, handler) }
        if (this.settled) {
            if (this.error === undefined) {
                handler(this.#event("update", this.assertions))
                // Replay `complete` too.  An element that renders on it would
                // otherwise render only for the first subscriber.
                handler(this.#event("complete"))
            } else {
                handler(this.#event("error", this.error))
            }
        }
        return () => { for (const action of LIFECYCLE) { this.removeEventListener(action, handler) } }
    }

    /**
     * Hold an annotation against this Entity, keyed by version-chain root so a
     * new version replaces the one it supersedes.
     *
     * @param {Annotation} annotation the annotation to hold.  Its id may be
     * recorded as `@id` or `id`; Annotation#id reads either.
     * @returns {Boolean} whether it was taken — false for an annotation with no
     * id, which has no stable identity to key on.
     */
    attachAnnotation(annotation) {
        if (this.#adopted !== undefined) { return this.#adopted.attachAnnotation(annotation) }
        if (annotation.id === undefined || annotation.id === null) { return false }
        if (this.#strategy === "display") { return false }
        this.#annotations.set(versionRootId(annotation), annotation)
        this.#assertions = undefined
        return true
    }

    /**
     * Resolve this entity through its strategy's read path.  Concurrent calls
     * for the same id share one in-flight promise — two consumers of the same
     * deer-id cost one round trip.
     *
     * @param {Object} options `fresh: true` busts the HTTP cache (read-after-write).
     * @returns {Promise<void>} settles when resolution has been applied.  It
     * does not reject: a failure is announced as an `error` event and left on
     * the Entity, so subscribers see it whenever they arrive.
     */
    resolve({ fresh = false } = {}) {
        if (this.#adopted !== undefined) { return this.#adopted.resolve({ fresh }) }
        // Keyed by strategy as well as id: an editing caller must never be
        // handed a display resolution's promise, which resolves to a document
        // carrying no provenance at all.
        const key = `${this.#strategy}:${rerum.canonicalId(this.#id)}`
        const pending = inFlight.get(key)
        if (pending && pending.owner === this && (pending.fresh || !fresh)) { return pending.promise }
        // Starting a new resolution retires every older one.  The only way to
        // reach here with one already in flight is a fresh request overtaking a
        // non-fresh one, so newest-started is always the one that should win.
        this.#generation++
        // Retrying a FAILED resolution un-settles it, so a subscriber arriving
        // mid-retry waits for the real answer.
        if (this.#error !== undefined) { this.#settled = false }
        const promise = this.#resolveURI(fresh)
            .finally(() => { if (inFlight.get(key)?.promise === promise) { inFlight.delete(key) } })
        inFlight.set(key, { promise, fresh, owner: this })
        return promise
    }

    /**
     * Take the annotation documents this Entity's read returned.  Constructing
     * an Annotation self-wires it onto every Entity it targets, so attachment
     * is a side effect; attaching explicitly as well is what makes the count
     * honest, because attachAnnotation reports whether THIS Entity could key
     * on it.
     *
     * The read is AUTHORITATIVE: it returns every annotation this deployment has
     * against the entity, so the Map is rebuilt rather than added to.  Anything
     * held from an earlier read that this one did not return has been deleted,
     * retargeted, or has stopped matching the generator filter, and merging it
     * again resurrects a value the data no longer asserts.
     *
     * @param {Array<Object>} annotations annotation documents targeting this id.
     */
    #findAssertions = (annotations) => {
        this.#annotations = new Map()
        this.#assertions = undefined
        for (const anno of annotations) {
            this.attachAnnotation(new Annotation(anno))
        }
        this.#announce("update", this.assertions)
        this.#settled = true
        this.#announce("complete")
    }

    #resolveURI = async (fresh) => {
        // Captured before the first await.  A strategy change while this is in
        // flight bumps #generation, and everything below then belongs to a
        // resolution nobody wants — writing its result would clobber the newer
        // one.
        const generation = this.#generation
        const strategy = this.#strategy
        this.#error = undefined
        try {
            if (strategy === "display") {
                const resolved = await expand.forDisplay(this.#id, { fresh })
                if (generation !== this.#generation) { return }
                this.#dataStrategy = strategy
                this.#applying = true
                try { this.data = resolved } finally { this.#applying = false }
                if (generation !== this.#generation) { return }
                this.#settled = true
                this.#announce("complete")
                return
            }
            const { entity, annotations } = await expand.clientRead(this.#id, { fresh })
            if (generation !== this.#generation) { return }
            this.#dataStrategy = strategy
            this.#merging = true
            this.#applying = true
            try {
                this.data = entity
            } finally {
                this.#merging = false
                this.#applying = false
            }
            if (generation !== this.#generation) { return }
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
            id: this.id,
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

    // Self-wiring: an annotation attaches itself to every target the page is
    // ALREADY coordinating, so an annotation returned by one entity's read
    // reaches the other entities on the page that it also asserts about.
    //
    // It does not CONSTRUCT an Entity for a target nothing holds.  Constructing
    // one begins resolving it, so reading entity A pulled entity B — and B's
    // annotations — over the network as a side effect of a read nobody asked
    // for.
    #registerTargets = () => {
        let targets = this.data.target
        if (!Array.isArray(targets)) { targets = [targets] }
        for (let target of targets) {
            if (!target) { continue }
            target = target["@id"] ?? target.id ?? ((typeof target === "string") ? target : undefined)
            if (!target) { continue }
            // A target outside RERUM, or one carrying a fragment, simply finds
            // no holder — the map is keyed by canonical RERUM URIs — so it needs
            // no gate of its own now that nothing is constructed here.
            const held = EntityMap.get(rerum.canonicalId(target))
            if (held === undefined) { continue }
            held.attachAnnotation(this)
        }
    }
}

export { EntityMap, Entity, Annotation, objectMatch, getEntity, reserveEditing, clearEntities }
