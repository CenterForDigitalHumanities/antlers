/**
 * @module expand Entity resolution strategy — two read paths, chosen by consumer.
 * @author Patrick Cuba <cubap@slu.edu>
 * @author Bryan Haberberger <bryan.j.haberberger@slu.edu>
 *
 * Controls the expand logic that gathers Annotation objects targeting an
 * entity.  Annotation bodies are gathered and placed onto the entity
 * results in a single assembled and described entity.  This is a combined
 * effort with RERUM API services and DEER client functionality.
 */

import config, { asInteger, INTEGER_DEFAULTS } from './config.js'
import * as rerum from './rerum.js'
import * as logger from './log.js'
import { annotationTypeClauses, applyAssertions, isAnnotationType, mergeAssertions, project, requireDocument, shapeValues } from './assertions.js'
import {} from './types.js'

/**
 * Keep only the documents that are actually Annotations.
 */
const onlyAnnotations = (finds) => (Array.isArray(finds) ? finds : [])
    .filter(doc => doc && isAnnotationType([doc.type, doc["@type"]]))

/**
 * Refuse an id DEER cannot READ.  DEER writes entities in RERUM only, but a
 * read may reach a configured foreign base (antlers#9): a hosted Manifest is
 * a legal target, and its Annotations are still sought in RERUM.
 *
 * The common cause is not foreign data at all but a RERUM deployment on a host
 * config.ID_BASES does not list, so the message names that first.
 *
 * @param {String} uri the entity URI.
 * @throws {TypeError} when the id is not inside the read boundary.
 */
function requireReadableId(uri) {
    if (rerum.isReadableId(uri)) { return }
    throw new TypeError(`${uri} is not inside DEER's read boundary. Ids must be bare URIs — no query string, no fragment, no trailing slash — hosted by RERUM (config.ID_BASES) or by a configured config.READ_ID_BASES entry (read boundary: ${JSON.stringify(rerum.readBases())}).`)
}

/**
 * Refuse an id DEER cannot WRITE.  A read may reach a foreign base; an update
 * or overwrite may not — RERUM versions only what it stores.
 *
 * @param {String} uri the entity URI.
 * @throws {TypeError} when the id is not RERUM-hosted.
 */
function requireRerumId(uri) {
    if (rerum.isRerumId(uri)) { return }
    throw new TypeError(`${uri} is not hosted by RERUM, and DEER writes RERUM entities only. Ids must be bare URIs — no query string, no fragment, no trailing slash. If this IS your RERUM deployment, add its id base to config.ID_BASES (currently ${JSON.stringify(config.ID_BASES)}).`)
}

/**
 * The properties an Annotation can carry the URI of its target under.
 * KEEP IN STEP WITH THE SERVER: a key the server matches and this list does not
 * is an annotation `/expanded` merges and the client read never sees.
 * Configurable (antlers#9): a deployment annotating through other
 * vocabularies sets config.TARGET_KEYS rather than forking the read.
 */
const targetKeys = () => (Array.isArray(config.TARGET_KEYS) && config.TARGET_KEYS.length > 0)
    ? config.TARGET_KEYS : ["target", "target.@id", "target.id",
        "target.source", "target.source.@id", "target.source.id"]

/** Escape the RegExp metacharacters in a literal so it matches only itself. */
const escapeRegex = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * A paged query for every document matching a query.
 *
 * Exported for js/core/bulk.js's cascade gather, which must page exactly the
 * way the reads do (antlers#6).
 *
 * @param {Object} body the query document.
 * @param {String} label what is being read, for the refusal message.
 * @returns {Promise<Array<Object>>} every matching document.
 * @throws {RangeError} past config.MAX_RESULTS, rather than returning a partial merge.
 */
export async function queryAll(body, label) {
    // Guarded: a deployment that configures LIMIT at 0 or below would otherwise
    // page forever, asking for nothing each time.
    // This stops clients from silently truncating.
    // It is a guard against a known RERUM setting that keeps paging mechanics honest.
    const maxPage = Math.max(1, asInteger(config.MAX_LIMIT, INTEGER_DEFAULTS.MAX_LIMIT))
    const page = Math.min(maxPage, Math.max(1, asInteger(config.LIMIT, INTEGER_DEFAULTS.LIMIT)))
    const ceiling = Math.max(1, asInteger(config.MAX_RESULTS, INTEGER_DEFAULTS.MAX_RESULTS))
    const all = []
    const seen = new Set()
    // Counts RAW documents fetched, not deduped ones.
    let fetched = 0
    for (let skip = 0; ; skip += page) {
        const finds = await rerum.query(body, { limit: page, skip })
        const list = Array.isArray(finds) ? finds : []
        fetched += list.length
        for (const doc of list) {
            const key = rerum.canonicalId(doc?.["@id"] ?? doc?.id)
            // A document with no id has no identity to dedupe on.  It is kept —
            // the reads downstream discard it on their own terms.
            if (typeof key !== "string") { all.push(doc); continue }
            if (seen.has(key)) { continue }
            seen.add(key)
            all.push(doc)
        }
        if (list.length < page) { return all }
        if (fetched > ceiling) {
            throw new RangeError(`${label}: more than ${ceiling} documents fetched without reaching the end of this read.`)
        }
    }
}

/**
 * Every way an Annotation can name this entity as its target: each target key
 * against both protocol spellings, and each against a FRAGMENT of the URI
 * (`…#xywh=0,0,100,100`), which is the other W3C way to target part of a
 * resource and which an exact match does not catch.  `target.source` is the
 * W3C SpecificResource.
 *
 * Exported for js/core/bulk.js's cascade gather, which must match the same
 * shapes the reads do (antlers#6).
 *
 * @param {String} uri the entity URI.
 * @returns {Array<Object>} clauses for a Mongo-style `$or`.
 */
export function targetingClauses(uri) {
    const uris = rerum.idIn(uri)
    const fragments = ["http", "https"]
        .map(scheme => `^${escapeRegex(uri.replace(/^https?/, scheme))}#`)
    return targetKeys().flatMap(key => [
        { [key]: uris },
        ...fragments.map(pattern => ({ [key]: { "$regex": pattern } }))
    ])
}

/**
 * Every leaf Annotation targeting any URI the record answers to, from any
 * generator.  Generator scoping is applied by the caller — scoped-leaf
 * resolution resolves it client-side via history walks, which is what makes
 * a generator LIST (antlers#9) possible: each scope keeps its own last word.
 *
 * An undefined scope (the exhibit case) gathers every generator's leaves
 * as-is, since there is no "other generator" to walk back from.
 *
 * @param {Array<String>} uris every URI to match as a target.
 * @returns {Object} the query document.
 */
function targetingQuery(uris) {
    const query = {
        "$and": [
            { "$or": uris.flatMap(targetingClauses) },
            { "$or": annotationTypeClauses() },
            { "__rerum.history.next": [] }
        ]
    }
    return query
}

/**
 * Resolve scoped leaves from a set of leaf annotations: for each chain, keep
 * the most recent version authored by a generator in the deployment's read
 * scope.
 *
 * Leaves already in scope are kept as-is.  Leaves from a foreign generator
 * trigger a `history()` walk back through the ancestor chain to find the
 * most recent in-scope version.  Sibling leaves that share a
 * `__rerum.history.previous` are two branches of one chain, so only the first
 * walks and the rest reuse its result.
 *
 * The history endpoint returns ancestors newest first and excludes the leaf
 * itself, so the first in-scope version in walk order is the most recent.
 *
 * @param {Annotation[]} leaves leaf annotation documents from the targeting query.
 * @returns {Promise<Annotation[]>} the scoped leaves, ready to merge.
 */
async function resolveScopedLeaves(leaves) {
    const scopes = rerum.readScopes()
    // Exhibit mode: every leaf is in scope, and there is no "other generator"
    // to walk back from — the global leaf IS the last word.
    if (scopes === null) { return [...leaves] }
    const ours = new Map()
    const walkedChains = new Map()
    const scopeSet = new Set(scopes)
    if (scopeSet.size === 0) { return [] }
    for (const leaf of leaves) {
        const leafId = rerum.canonicalId(leaf?.["@id"] ?? leaf?.id)
        if (typeof leafId !== "string") { continue }
        if (scopeSet.has(rerum.canonicalId(leaf?.__rerum?.generatedBy))) {
            ours.set(leafId, leaf)
            continue
        }
        // __rerum.history.previous is the chain the leaf hangs from; sibling
        // branches share it, so one history() walk answers for all of them.
        const previous = rerum.canonicalId(leaf?.__rerum?.history?.previous)
        if (typeof previous !== "string" || previous === "") { continue }
        if (walkedChains.has(previous)) {
            for (const version of walkedChains.get(previous)) { ours.set(version["@id"], version) }
            continue
        }
        try {
            const ancestors = await rerum.history(leafId)
            // Ancestors arrive newest first.  The first in-scope version is the
            // most recent word a scoped generator had on this chain.
            const found = []
            for (const version of ancestors) {
                if (!scopeSet.has(rerum.canonicalId(version?.__rerum?.generatedBy))) { continue }
                const versionId = rerum.canonicalId(version?.["@id"] ?? version?.id)
                if (typeof versionId !== "string") { continue }
                found.push({ ...version, "@id": versionId })
                break
            }
            walkedChains.set(previous, found)
            for (const version of found) { ours.set(version["@id"], version) }
        } catch {
            // History fetch failed — skip this chain rather than failing the read.
        }
    }
    return [...ours.values()]
}

/**
 * The client read path: an entity document and the scoped-leaf Annotation
 * documents targeting it, RAW.
 *
 * Two requests: a direct GET for the entity and one paged query for all leaf
 * Annotations targeting it.  A record with a RERUM Slug costs one further
 * query.  Foreign-generator leaves trigger additional `/history` calls to
 * walk back to the most recent version this deployment authored.
 *
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {ReadOptions} [options] `fresh` busts the HTTP cache on the entity GET.
 * @returns {Promise<ClientRead>} raw documents: the entity, and the scoped-leaf
 * annotations for this deployment.
 * @throws {TypeError} when the id is not inside the read boundary, or the
 * generator scope is misconfigured.
 */
export async function clientRead(id, { fresh = false } = {}) {
    const uri = rerum.idOf(id)
    requireReadableId(uri)
    rerum.readScopes()
    const annotationQuery = targetingQuery([uri])
    const [resolved, list] = await Promise.all([
        rerum.resolve(uri, { fresh }),
        queryAll(annotationQuery, uri)
    ])
    const entity = requireDocument(resolved, `The read of ${uri}`)
    const isSelf = (doc) => rerum.canonicalId(doc?.["@id"] ?? doc?.id) === rerum.canonicalId(uri)
    const primaryLeaves = onlyAnnotations(list.filter(doc => !isSelf(doc)))
    const aliasLeaves = await aliasTargetedAnnotations(entity, uri, primaryLeaves)
    const scopedLeaves = await resolveScopedLeaves(primaryLeaves.concat(aliasLeaves))
    return { entity, annotations: scopedLeaves }
}

/**
 * Every URI this record answers to: its own `@id` and, when it has one, its
 * RERUM Slug URI.
 *
 * @param {Object} entity the raw entity document.
 * @returns {Array<String>} the URIs, in no particular order.
 */
function recordUris(entity) {
    const own = entity?.["@id"] ?? entity?.id
    return [own, rerum.slugUriOf(entity)].filter(u => typeof u === "string" && u.length > 0)
}

/**
 * The annotations targeting a URI this record answers to that the FIRST query
 * did not cover. Costs nothing for a record with no slug.
 *
 * A SECOND round trip, and unavoidable: the server knows every URI before it
 * queries because it has already loaded the record, while a client cannot learn
 * the others until the first read hands it the document.
 *
 * @param {Object} entity the raw entity document.
 * @param {String} requestedUri the URI clientRead was called with, already covered.
 * @param {Array<Object>} found the annotations the first query already returned.
 * @returns {Promise<Array<Object>>} the additional annotations, deduplicated.
 */
async function aliasTargetedAnnotations(entity, requestedUri, found) {
    const requested = rerum.canonicalId(requestedUri)
    const aliases = recordUris(entity).filter(u => rerum.canonicalId(u) !== requested)
    if (aliases.length === 0) { return [] }
    const list = await queryAll(targetingQuery(aliases), aliases.join(", "))
    // An annotation can name the entity by BOTH URIs, and the entity itself can
    // come back here when the slug resolves to it, so dedupe on what the first
    // query already produced rather than trusting the two result sets to be
    // disjoint.
    const seen = new Set([...found, entity]
        .map(doc => rerum.canonicalId(doc?.["@id"] ?? doc?.id))
        .filter(k => typeof k === "string"))
    return onlyAnnotations(list).filter(doc => !seen.has(rerum.canonicalId(doc["@id"] ?? doc.id)))
}

/**
 * Resolve an entity for display, RAW — the server-side annotation merge exactly
 * as `/expanded` returns it.  Cacheable (the server sends max-age=86400,
 * must-revalidate) and carries no annotation provenance.
 *
 * Two scopes fall back to the client read (antlers#9): a foreign id has no
 * `/expanded` route, and a read gathering MORE than one generator cannot be
 * asked of the server, whose `?generator=` takes a single agent.  DEER's
 * single-generator default uses the server merge, so the common case is one
 * request.
 *
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {ReadOptions} [options] `fresh: true` busts the HTTP cache (read-after-write).
 * @returns {Promise<RerumDocument>} the merged entity document, unshaped.
 * @throws {TypeError} when the id is outside the read boundary.
 */
export async function forDisplayRaw(id, { fresh = false } = {}) {
    const uri = rerum.idOf(id)
    requireReadableId(uri)
    const scopes = rerum.readScopes()
    // The server merge needs a RERUM record AND a single generator to ask for.
    // Foreign bases (antlers#9) have no /expanded route; exhibit mode and a
    // generator LIST cannot name one agent in ?generator=.
    const serverMerge = rerum.isRerumId(uri) && Array.isArray(scopes) && scopes.length === 1
    if (serverMerge) {
        const { document, gathered, merged } = await rerum.expanded(uri, { fresh })
        if (gathered === null || merged === null) {
            const { entity, annotations } = await clientRead(uri, { fresh })
            return mergeAssertions(entity, annotations, { provenance: false })
        }
        if (gathered !== merged && logger.debug("expand.merge-counts",
            `${uri}: server merged ${merged} of ${gathered} annotations. The rest assert nothing DEER reads (multi-key, multi-body, or protected-key bodies).`,
            { uri, gathered, merged })) { /* gated: emitted only under DEBUG */ }
        return requireDocument(document, `The expanded read of ${uri}`)
    }
    const { entity, annotations } = await clientRead(uri, { fresh })
    return mergeAssertions(entity, annotations, { provenance: false })
}

/**
 * Resolve an entity for display, DEER-shaped.
 *
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {ReadOptions} [options] `fresh: true` busts the HTTP cache (read-after-write).
 *   `properties` (Array<String>|String) projects the result down to those
 *   properties plus identity keys — a display that only wants `label`, `age`,
 *   and `gravatar_uri` requests exactly those.
 * @returns {Promise<ShapedEntity>} DEER-shaped entity: asserted properties become
 * ValueObjects (arrays thereof when multivalued).  No value carries a
 * `citationSource` — the display path never has one to carry.
 * @throws {TypeError} when the id is outside the read boundary.
 */
export async function forDisplay(id, options) {
    const shaped = shapeValues(await forDisplayRaw(id, options))
    return project(shaped, options?.properties)
}

/**
 * Resolve an entity for editing: always the client path, always cache-busted —
 * a form prefill must never show a stale read after a write.  Merged values
 * carry `source.citationSource` so the form knows which annotation to update.
 *
 * @param {String|Object} id the entity URI or an object carrying one.
 * @param {ReadOptions} [options] `properties` (Array<String>|String) projects the
 * result down to those properties plus identity keys.
 * @returns {Promise<ShapedEntity>} DEER-shaped entity with full annotation provenance.
 * @throws {TypeError} when the id is outside the read boundary.
 */
export async function forEditing(id, options) {
    const { entity, annotations } = await clientRead(rerum.idOf(id), { fresh: true })
    return project(applyAssertions(entity, annotations), options?.properties)
}
