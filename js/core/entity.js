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
 * "Coordination, not a cache" is enforced at both ends.  An Entity leaves the
 * map once its last subscriber unsubscribes (Entity#subscribe returns the
 * teardown; the elements layer MUST call it from disconnectedCallback), because
 * an Entity nobody is listening to has no coordination left to do and the HTTP
 * cache makes re-resolving it nearly free.  And a record that turns out to
 * answer to a URI another Entity already holds does not overwrite it — see
 * Entity#adopt.
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
import { applyAssertions, markShaped, shapeValues } from './assertions.js'

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

/**
 * The second EntityMap key a record with a RERUM Slug answers to: the shared
 * rerum.slugUriOf construction, canonicalized the way every map key is.
 * canonicalId passes undefined through, so a record without a slug stays
 * undefined here too.
 * @param {Object} doc a resolved entity document.
 * @returns {String|undefined} the canonical slug URI, or undefined without one.
 */
const slugAliasOf = (doc) => rerum.canonicalId(rerum.slugUriOf(doc))

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
    // Refused here rather than left to the constructor, so all three ways of
    // arriving without an id fail identically.  keyOf(null) is undefined, the
    // map lookup misses, and `new Entity(null)` would throw a bare "Cannot read
    // properties of null (reading '@id')" -- and null is the likeliest way to
    // get here, because getAttribute() returns it for a missing deer-id.
    if (typeof key !== "string" || key.length === 0) { throw new Error("Entity must have an id") }
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
 *
 * Ordinary sessions no longer need this to bound the map: an Entity releases its
 * keys when its last subscriber leaves.  `editingIds` is the exception and is
 * deliberately NOT tied to that — a reservation describes the ids a page's forms
 * carry, not whether an Entity for one happens to exist right now, and dropping
 * it early would silently downgrade a form's next read to the display path.
 */
function clearEntities() {
    // Retire every in-flight read BEFORE the map is emptied.  Clearing the map
    // does not cancel a fetch, and a resolution that lands afterwards
    // re-registers its Entity through `set data` -- #register only refuses an
    // Entity that has been RELEASED, and a never-subscribed one has not been.
    // Measured: map size 0, then 1 again a second later, holding the same object
    // this teardown was called to be rid of.
    for (const held of new Set(EntityMap.values())) { held.retire() }
    EntityMap.clear()
    inFlight.clear()
    editingIds.clear()
    // The write-invalidation bookkeeping lives in rerum.js and would otherwise
    // outlive this teardown, leaving a forced reload pending for the next
    // session's first read.  expand.js keeps its own per-deployment warning log
    // for the same lifetime, and a Set left populated there silently suppresses
    // a warning the next session should see.
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
 * @class
 */
class Entity extends EventTarget {
    #strategy
    // Which read path produced the document currently in _data, as opposed to
    // #strategy, which is the path this Entity is HEADING for.  They differ from
    // the moment upgradeToEditing() flips the strategy until that read lands,
    // and `assertions` has no correct answer to give in between.  undefined
    // until the first resolution applies — the constructor's stub belongs to
    // neither path.
    #dataStrategy
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
    // True only while a resolution is writing its own result into _data, which
    // is what tells `set data` an id change came from the read rather than from
    // a consumer reassigning the document.  See `set data`.
    #applying = false
    // Annotations is a PUBLIC read surface but a private field, so an adopted
    // Entity can delegate it.  Internal writers use this; nothing outside reads
    // anything but the getter.
    #annotations
    // The Entity this one deferred to, if it lost an identity collision.  See
    // #adopt.  Every read on this object delegates to it from then on.
    #adopted
    // Tears down the event forwarding #adopt set up, or undefined when this
    // Entity is not currently forwarding.
    #stopForwarding
    // Every EntityMap key this Entity registered under.  A record is reached by
    // more than one URI (the URI a consumer arrived with, the `@id` its read
    // returned, its Slug alias), and #release has to remove ALL of them -- a key
    // left pointing at a released Entity is worse than no release at all.
    #mapKeys = new Set()
    // Live subscribe() calls.  The map holds an Entity forever otherwise: it is
    // render coordination, not a cache, so an Entity nothing is listening to has
    // no coordination left to do.  See #release.
    #subscribers = 0
    // Whether subscribe() has EVER been called.  #register consults both: a
    // released Entity (had subscribers, has none) must stay out of the map,
    // while a never-subscribed one still registers -- it may be seconds from
    // its first subscriber, and evicting it on construction would defeat the
    // deduplication the map exists for.
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
        // `@id` before `id`, the same order keyOf, rerum.idOf, `set data`,
        // Annotation#id and clientRead's isSelf all use.  Reversed, this method
        // checked the map under one key and registered under the other, and a
        // document carrying both — `{"@id": "…", id: 12345}` — was rejected as
        // having no id at all.
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
     * read from it here — the same way Annotation#id does.
     */
    get id() {
        return this.#adopted?.id ?? this.#id
    }

    get data() {
        return (this.#adopted !== undefined) ? this.#adopted.data : this._data
    }

    /**
     * The DEER-shaped view of this Entity.  Memoized: recomputing it means a
     * structuredClone and a full merge, and `set data`, every attachment, and
     * every subscriber reading `detail.payload` would each pay for one.
     * Invalidated by anything that changes the document or its annotations.
     */
    get assertions() {
        if (this.#adopted !== undefined) { return this.#adopted.assertions }
        // upgradeToEditing() flips #strategy before its read lands, so there is
        // a window where _data is still the SHAPED display document and the
        // editing branch below would merge over it.  structuredClone breaks the
        // SHAPED identity, so every value object gets unwrapped and re-wrapped:
        // the output looks right and has silently lost every citationSource,
        // which is what makes the next form save POST a duplicate assertion.
        // There is no correct answer to give in that window, so give none.
        // assertionsForEditing() awaits the upgrade and never sees this.
        // Settled-ness is NOT part of this test.  #fail() sets #settled, so
        // gating on `!this.#settled` switched the guard off in exactly the case
        // it is most needed: an editing upgrade that FAILED leaves _data holding
        // the display document with #strategy already flipped, and the merge
        // below then runs over an already-shaped document.  structuredClone
        // breaks the SHAPED identity, so every value object is unwrapped and
        // re-wrapped -- the output looks correct and has silently lost every
        // citationSource, which is what makes the next form save POST a
        // duplicate assertion.  The only question that matters is whether _data
        // came from the strategy about to be applied to it.
        //
        // Safe on every success path: #resolveURI assigns #dataStrategy BEFORE
        // it assigns _data, on both branches, so a resolved Entity always has
        // the two in agreement.  It is undefined for the constructor's stub,
        // which belongs to neither path.
        if (this.#dataStrategy !== undefined && this.#dataStrategy !== this.#strategy) {
            const why = (this.#error === undefined)
                ? `the ${this.#dataStrategy} read is being upgraded to ${this.#strategy}`
                : `the upgrade from the ${this.#dataStrategy} read to ${this.#strategy} failed (${this.#error.message})`
            throw new Error(`${this.#id}: assertions are not available -- ${why}. Await assertionsForEditing(), or render on the 'update'/'complete' events.`)
        }
        if (this.#assertions === undefined) {
            // The display read comes back already shaped by expand.forDisplay
            // and has no annotations to merge; only the editing read does.
            // shapeValues still runs over it because a CONSUMER-assigned
            // document is raw, and handing that out as-is broke the one-shape
            // contract on exactly one of the two strategies -- the editing
            // branch merges through applyAssertions, which ends in shapeValues
            // either way.  Idempotent for the read path: set data's shallow
            // copy preserves the SHAPED identity of every value object, so a
            // forDisplay document passes through untouched.
            // Cloned, not aliased, so no caller is handed the Entity's own
            // document.  The editing branch already returns a fresh object.
            //
            // Frozen because the memo is SHARED, which the clone alone does not
            // address: every subscriber — including the ones subscribe() catches
            // up after settling — receives this same object as detail.payload,
            // so one of them mutating it corrupts the value all the others were
            // given.  Cloning per read would fix that too, but it defeats the
            // memo, which exists because recomputing means a structuredClone and
            // a full merge on every read.  Freezing keeps one object and turns
            // the corruption into a throw.
            //
            // Cloned OUTSIDE the branch so the memo owns every object it
            // freezes.  applyAssertions clones the entity but not the
            // annotations, and buildValueObject's `value` is whatever getValue
            // returned — for an object or array body value, a live reference
            // into Annotation.data.  deepFreeze followed those references and
            // froze documents this Entity does not own: a multi-target
            // annotation shared with another Entity, and the very objects a form
            // would build its next PUT body from.
            // markShaped re-brands the clone.  Shaping is idempotent by object
            // IDENTITY (assertions.SHAPED), and structuredClone produces objects
            // that WeakSet has never seen -- so without this the memo handed to
            // every subscriber is unrecognizable as shaped, and anything that
            // shapes it again unwraps and re-wraps each value, silently losing
            // every citationSource.  deepFreeze makes an accidental MUTATION of
            // the shared memo loud; this is what makes an accidental RESHAPE of
            // it harmless.
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
        // IDENTITY COLLISION, resolved BEFORE anything is mutated.  A record with
        // a RERUM Slug answers to two URIs, and the alias can only be registered
        // once a read has handed over the document -- so two consumers arriving
        // by the two URIs within one read's latency both find the map empty and
        // both construct.  Overwriting the incumbent here left one live Entity,
        // with live subscribers, that nothing would ever route an update to:
        // measured at 5 requests for one record, two objects, and whichever one
        // resolved last silently winning both keys.  Deferring is the honest
        // move -- this resolution has just discovered it is a duplicate of one
        // already in hand.  Checked before `_data` is touched so an adopted
        // Entity never half-applies a document it is about to disown.
        const incumbent = EntityMap.get(canonical)
        if (incumbent !== undefined && incumbent !== this) {
            this.#adopt(incumbent)
            return
        }
        this._data = candidate
        this.#assertions = undefined
        this.#id = nextId
        // A resolution assigns #dataStrategy before it assigns here, so anything
        // reaching this without #applying is a CONSUMER-supplied document, which
        // came from neither read path -- exactly the position the constructor's
        // stub is in.  Saying so keeps the upgrade guard in `assertions` pointed
        // at the window it exists for instead of firing on a document that has
        // nothing to do with it.
        if (!this.#applying) { this.#dataStrategy = undefined }
        // When resolution changes the id, the previous key is left pointing at
        // this same Entity on purpose — consumers that arrived with the old URI
        // keep resolving to it rather than constructing a second object.
        this.#register(canonical)
        // A record answering to a Slug answers to TWO URIs, and RERUM treats
        // them as one record — `/id/:_id` and `/id/:_id/expanded` both look up
        // `{$or: [{_id}, {__rerum.slug}]}`.  Registering the alias makes this
        // map agree.  Without it an annotation targeting the slug URI sends
        // Annotation#registerTargets to getEntity() with a key nothing holds, so
        // it builds a SECOND Entity for the same record, which resolves itself
        // all over again: measured at 5 requests and two map entries for one
        // record, with two assertion memos and two subscriber lists that never
        // learn of each other's updates.  Registered here, before
        // #findAssertions constructs any Annotation, so the alias is in place
        // when the self-wiring runs.
        const slugUri = slugAliasOf(candidate)
        if (slugUri !== undefined) { this.#register(slugUri) }
        // Silent while an editing resolution is mid-merge.  The raw entity
        // without its annotations is not a smaller version of the answer, it is
        // a document with NO PROVENANCE IN IT — same DEER shape, fewer keys, no
        // `source.citationSource` anywhere — and nothing on the event or the
        // Entity distinguishes it from a finished one (`settled` is false for
        // both).  A form prefilling on that `update` POSTs a duplicate
        // assertion on every save instead of updating the annotation already
        // there: silent corruption, which is what this rewrite exists to end.
        // #findAssertions announces once, after the merge.
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
            // comes back carrying the record's own `@id` and lands here -- but
            // the document that read returned IS the record, so re-resolving
            // fetches what is already in hand.  Measured on `someguynamedsteve`
            // before this guard: 5 requests instead of 2, `complete` announced
            // twice, and the Entity settled on the first read while the second
            // was still in flight.  The slug alias registered above is what
            // later consumers arrive through.
            //
            // The branch still stands for its real case: a CONSUMER assigning a
            // document with a different id.
            //
            // Re-resolve under the new URI and tell subscribers to repaint — but
            // only if that resolution produced something.  A failed resolve
            // leaves the stub behind, and painting it over good data is worse
            // than not repainting at all.
            // The shaped document, matching what `update` carries.  subscribe()
            // hands every lifecycle event to one handler, so a payload that is
            // sometimes an Entity and sometimes a document means any consumer
            // reading `detail.payload.name` works for one event and breaks on
            // the other.
            this.resolve().then(() => { if (this.error === undefined) { this.#announceShaped("reload") } })
        }
    }

    /**
     * Claim an EntityMap key for this Entity and remember that it did.  A record
     * is reached by more than one URI, and #release has to give every one of them
     * back — a key left pointing at a released Entity is worse than no release.
     * @param {String} key the canonical map key.
     */
    #register = (key) => {
        this.#mapKeys.add(key)
        // A released Entity must not re-claim map slots.  Unsubscribing does
        // not cancel an in-flight read, and the landing read reaches here
        // through `set data`; without this test it re-entered the map with zero
        // subscribers, where nothing would ever evict it -- #release only fires
        // on the 1 -> 0 transition.  The key is still recorded above, so
        // #reclaim restores it if this Entity is ever subscribed again.
        if (this.#everSubscribed && this.#subscribers === 0) { return }
        EntityMap.set(key, this)
    }

    /**
     * Defer to the Entity already coordinating this record.
     *
     * Called only from `set data`, when a resolution discovers that the URI its
     * document actually names is already held by a different Entity — the Slug
     * collision described there.  This object keeps working for whoever already
     * holds it: every read delegates to the incumbent, and the incumbent's
     * lifecycle is re-dispatched here so subscribers registered on this object
     * are caught up and stay current.  New consumers reach the incumbent
     * directly, because every key this Entity claimed is re-pointed at it.
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
        // with them.  Left behind here, the incumbent could hit zero and
        // release itself — keys out of the map, a third Entity constructed for
        // the record — while consumers were still listening through this
        // object's forwarding.  Their teardowns decrement through `#adopted`
        // (see subscribe), so the count settles on the incumbent when they
        // leave, and net attendance is unchanged.
        if (this.#subscribers > 0) {
            incumbent.#subscribers += this.#subscribers
            incumbent.#everSubscribed = true
            this.#subscribers = 0
        }
        // This Entity's own in-flight resolution is now redundant work whose
        // result must not be applied.  Bumping the generation retires it through
        // the checks #resolveURI already makes, so it lands and is discarded
        // instead of settling this object over the top of the delegation.
        this.#generation++
        this._data = undefined
        this.#assertions = undefined
        this.#annotations = new Map()
        this.#forwardFrom(incumbent)
    }

    /**
     * Re-dispatch another Entity's lifecycle on this one.  #listen replays for an
     * incumbent that has already settled, so a subscriber registered here before
     * the adoption is caught up rather than left waiting for an event that
     * already fired.
     * @param {Entity} incumbent the Entity to forward from.
     */
    #forwardFrom = (incumbent) => {
        this.#stopForwarding = incumbent.#listen((ev) => {
            this.dispatchEvent(new CustomEvent(ev.detail.action, { detail: { ...ev.detail } }))
        })
    }

    /**
     * Give up this Entity's map keys once nothing is listening to it.
     *
     * EntityMap is render coordination, not a cache — an Entity no subscriber
     * holds has no coordination left to do, and the browser HTTP cache makes
     * re-resolving a re-rendered id nearly free.  Without this the map retains
     * every record a session ever touched, each holding its document, a frozen
     * assertions memo (a second full copy) and every annotation document behind
     * it: measured at ~15.8 KB of heap per Entity, none of it ever returned.
     *
     * The Entity object itself is NOT destroyed — whoever still holds a
     * reference keeps a working object, and subscribing again reclaims the keys.
     * Only Entities that have had a subscriber are released; one that never had
     * any may be seconds away from its first, and evicting on construction would
     * defeat the deduplication this map exists for.
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
        // While this Entity was released another may have claimed its keys.
        // That one is the record's coordinator now, so DEFER to it rather than
        // re-entering beside it.  Reclaiming only the still-free keys left two
        // live Entities for one record — separate documents, memos, and
        // subscriber lists, with an update routed through the map reaching one
        // of them and the re-subscriber replayed a stale document forever.
        // That is the divergence #adopt exists to prevent, and `set data`
        // already resolves the same collision the same way.
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
     * of a property setter.  `assertions` refuses to answer while _data and the
     * strategy disagree, and applyAssertions can fail on a document it cannot
     * merge; a throw escaping `set data` left the Entity torn — _data, #id and
     * its map registration already changed, no announcement made, and no
     * resolution pending to repair it. A document this Entity cannot shape is a
     * failed resolution like any other, so it is reported as one.
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
     * Prefer reserveEditing() at scan time: reaching here means a display read
     * was paid for and is now being discarded.
     * @returns {Promise<void>} settles when the re-resolution has been applied.
     */
    upgradeToEditing() {
        if (this.#adopted !== undefined) { return this.#adopted.upgradeToEditing() }
        if (this.#strategy === "editing") {
            // Already on the right path.  A settled SUCCESS needs no read —
            // resolve() would issue a whole new one for nothing — but a settled
            // FAILURE is not an answer: #fail() sets #settled too, and treating
            // the two alike made assertionsForEditing() replay the stale error
            // forever, with no request made and no retry a form could reach.
            // resolve() un-settles a failed Entity and retries fresh; an
            // unsettled one shares the resolution already in flight.
            return (this.#settled && this.#error === undefined)
                ? Promise.resolve()
                : this.resolve({ fresh: this.#error !== undefined })
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
     * Discard whatever read is in flight on this Entity, so its result is never
     * applied.  Bumping the generation retires it through the checks
     * #resolveURI already makes, exactly the way #adopt and upgradeToEditing()
     * retire a read they have superseded.
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
     * @param {Function} handler receives the same CustomEvents addEventListener would.
     * @returns {Function} call to unsubscribe.
     */
    subscribe(handler) {
        // An adopted Entity has no lifecycle of its own — subscribing through
        // it is subscribing to the RECORD, so the registration and the count
        // both belong on the incumbent.  Counting here instead let the
        // incumbent hit zero and release itself while consumers were still
        // listening through this object: its keys left the map, a third
        // Entity was constructed for the record, and this delegation chain
        // never heard from it again.
        if (this.#adopted !== undefined) { return this.#adopted.subscribe(handler) }
        // First subscriber after a #release puts this Entity back in the map, so
        // the ordinary custom-element disconnect/reconnect cycle does not leave
        // a working Entity that no new consumer can find.
        if (this.#subscribers === 0) { this.#reclaim() }
        // #reclaim adopts the Entity that claimed this one's keys while it was
        // released, so the delegation above has to be re-checked.
        if (this.#adopted !== undefined) { return this.#adopted.subscribe(handler) }
        this.#everSubscribed = true
        this.#subscribers++
        const stop = this.#listen(handler)
        // Idempotent: an element calling its unsubscribe twice (a disconnect
        // followed by a teardown, say) must not decrement twice and release an
        // Entity other subscribers are still holding.
        let done = false
        return () => {
            if (done) { return }
            done = true
            stop()
            // Decrement whoever owns the count NOW.  #adopt transfers this
            // Entity's live count to its incumbent, so a teardown created
            // before an adoption must release the incumbent, not this object —
            // decrementing here would leave the incumbent pinned in the map by
            // a count nothing can ever bring back down.
            const owner = this.#adopted ?? this
            owner.#subscribers--
            if (owner.#subscribers === 0) { owner.#release() }
        }
    }

    /**
     * Register a handler on the whole lifecycle and catch it up, WITHOUT
     * counting it as a subscriber.  #adopt forwards through this: an adopter is
     * not a consumer, and counting it would pin the incumbent in the map for as
     * long as the adopter existed, which is the leak #release exists to close.
     * (The adopter's own SUBSCRIBERS are consumers — #adopt transfers their
     * count to the incumbent separately.)
     * Reads go through the public getters so an adopted Entity catches up from
     * the record's real state rather than from its own empty shell.
     * @param {Function} handler receives the same CustomEvents addEventListener would.
     * @returns {Function} call to detach.
     */
    #listen = (handler) => {
        for (const action of LIFECYCLE) { this.addEventListener(action, handler) }
        if (this.settled) {
            if (this.error === undefined) {
                handler(this.#event("update", this.assertions))
                // Replay `complete` too.  An element that renders on it would
                // otherwise render only for the first subscriber — which is the
                // several-elements-on-one-deer-id case this Map exists for.
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
     * @param {Annotation} annotation the annotation to hold.  Its id may be
     * recorded as `@id` or `id`; Annotation#id reads either.
     * @returns {Boolean} whether it was taken — false for an annotation with no
     * id, which has no stable identity to key on.
     */
    attachAnnotation(annotation) {
        if (this.#adopted !== undefined) { return this.#adopted.attachAnnotation(annotation) }
        if (annotation.id === undefined || annotation.id === null) { return false }
        // A display Entity's assertions come pre-merged from the server, so the
        // `assertions` getter never reads this Map.  Holding an annotation here
        // would leave `Annotations` -- a PUBLIC property -- meaning one thing on
        // an editing Entity and an arbitrary subset of multi-target annotations
        // on a display one, while invalidating a memo whose recomputation is
        // byte-identical.  Refusing completes the intent already stated at
        // Annotation#registerTargets: holding Annotation objects only matters to
        // the editing path.  An upgrade rebuilds the Map from its own read, so
        // nothing is lost by declining now.
        if (this.#strategy === "display") { return false }
        this.#annotations.set(versionRootId(annotation), annotation)
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
        if (this.#adopted !== undefined) { return this.#adopted.resolve({ fresh }) }
        // Keyed by strategy as well as id: an editing caller must never be
        // handed a display resolution's promise, which resolves to a document
        // carrying no provenance at all.
        const key = `${this.#strategy}:${rerum.canonicalId(this.#id)}`
        const pending = inFlight.get(key)
        // Only THIS Entity's own pending read can satisfy this call.  The map
        // is keyed by id, but the promise in it does one specific instance's
        // work — and since #release an id can outlive its Entity, so a read
        // still in flight can belong to a RELEASED predecessor.  Waiting on
        // that one strands this Entity forever: the predecessor's landing read
        // finds this Entity in the map and adopts it, retiring itself
        // unsettled, while this one sits on the retired promise — mutual
        // deferral, no fetch of its own, no error, no events.
        // A pending non-fresh resolution also cannot satisfy a fresh request —
        // read-after-write must never be served a stale in-flight promise.
        if (pending && pending.owner === this && (pending.fresh || !fresh)) { return pending.promise }
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
        inFlight.set(key, { promise, fresh, owner: this })
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
        this.#annotations = new Map()
        // Rebuilding the Map changes the merge even when nothing re-attaches, so
        // the memo cannot survive it.  attachAnnotation invalidates for each
        // annotation this read DID return, and `set data` for a changed entity
        // document — but a read that returns NO annotations for an entity whose
        // document is unchanged hits neither, and `set data` suppresses itself
        // as a no-op.  The announcement below then hands subscribers the
        // previous merge, still carrying values whose annotations have been
        // deleted, retargeted, or have stopped matching the generator filter.
        this.#assertions = undefined
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
                // Before `set data`, which reads `assertions` to announce with.
                this.#dataStrategy = strategy
                this.#applying = true
                try { this.data = resolved } finally { this.#applying = false }
                // `set data` announces `update`, and a subscriber may start a
                // new resolution from that handler.  Settling on this one would
                // then announce a `complete` the newer read announces again.
                if (generation !== this.#generation) { return }
                this.#settled = true
                this.#announce("complete")
                return
            }
            // The editing read belongs to expand.clientRead; Entity holds the
            // parts it returns rather than re-deriving them, so there is one
            // implementation of the provenance-critical path, not two.
            const { entity, annotations } = await expand.clientRead(this.#id, { fresh })
            if (generation !== this.#generation) { return }
            // Before `set data` and #findAssertions, both of which read
            // `assertions` — which refuses to answer while this disagrees with
            // #strategy.
            this.#dataStrategy = strategy
            // Held across `set data` so it cannot announce a half-merged
            // document; #findAssertions announces the finished one.  try/finally
            // because a throw out of `set data` must not leave the flag set and
            // silence every later announcement on this Entity.
            this.#merging = true
            this.#applying = true
            try {
                this.data = entity
            } finally {
                this.#merging = false
                this.#applying = false
            }
            // Committing a resolution that has been retired settles the Entity
            // on a read already superseded and announces a `complete` the newer
            // read will announce again.
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
            // The delegating getter: an adopted Entity announces the record's
            // real URI, not the alias it happened to be constructed with.
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
    // for; and because #release only fires on the subscriber 1 -> 0 transition,
    // an Entity created here never gets a subscriber and so can NEVER be
    // released.  It held its document, its assertions memo and every annotation
    // behind it for the life of the session — measured at two map entries and
    // two unrequested queries from a single two-target annotation, which is the
    // retention #release exists to prevent, reopened on a path it cannot reach.
    //
    // Nothing is lost by declining: the Entity whose read produced this
    // annotation attaches it explicitly (see Entity#findAssertions), and an
    // Entity resolved later runs its own query, which matches on every target
    // key and returns this annotation again.
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
