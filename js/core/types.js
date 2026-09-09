/**
 * @module types Shared JSDoc typedefs for the DEER core layer.
 * @author Patrick Cuba <cubap@slu.edu>
 *
 * The shapes that recur across the layer, named once (antlers#7) so the
 * modules can reference them with @type/@param/@returns tags instead of
 * re-describing them in prose.  These exist for linting and editor support —
 * nothing here runs; there is no runtime export.  Importing this module from
 * code is a no-op that only pulls the types into JSDoc scope.
 *
 * Nothing here is a class or a validation.  When a function needs a narrower
 * shape than one of these, it tags the narrower thing inline.
 */

/**
 * A URI string, canonicalized or not.  DEER accepts both protocol spellings
 * everywhere a RERUM id is read; rerum.canonicalId picks the https one.
 *
 * @typedef {String} URI
 */

/**
 * The RERUM system property every stored document carries: history pointers
 * (`prime`, `previous`, `next[]`), `generatedBy`, release state.
 *
 * @typedef {Object} RerumMetadata
 * @property {URI} generatedBy the agent that wrote this document.
 * @property {{prime: (URI|"root"), previous: (URI|""), next: URI[]}} history version-chain pointers; `next` empty on a leaf.
 * @property {String} [slug] the RERUM Slug this record also answers to.
 */

/**
 * A document stored by RERUM, raw: an entity, an Annotation, or any other
 * write.  Exactly one of `@id`/`id` is present; the context decides which.
 *
 * @typedef {Object} RerumDocument
 * @property {URI} [@id] the document URI, JSON-LD spelling.
 * @property {URI} [id] the document URI, plain spelling.
 * @property {String} [@type] the JSON-LD class.
 * @property {String} [type] the plain class spelling.
 * @property {RerumMetadata} [__rerum] system metadata, present on stored documents.
 */

/**
 * A W3C Web Annotation targeting an entity, as RERUM stores it.  Only
 * `body`/`bodyValue` contribute on merge; every other property is provenance.
 *
 * @typedef {RerumDocument} Annotation
 * @property {URI|Object|Array} target the entity targeted: a URI, an object
 * bearing one, a W3C SpecificResource, or an Array of any of those.
 * @property {Object|Object[]|String} [body] the assertions: a single-key
 * object, a TextualBody, or a one-element array unwrapping to either.
 * @property {String} [bodyValue] the W3C shorthand for a textual body.
 * @property {URI} [creator] who is responsible for the annotation.
 * @property {URI} [evidence] supporting evidence for the assertion.
 * @property {String} [motivation] the Web Annotation motivation.
 */

/**
 * The DEER value wrapper.  After shapeValues/applyAssertions, every
 * non-identity property on a resolved entity is one of these, or an Array
 * of them.  `source.citationSource` is the annotation `@id` to update in
 * place; the display path never carries one.
 *
 * @typedef {Object} ValueObject
 * @property {any} value the asserted value, normalized by getValue.
 * @property {{citationSource?: URI, citationNote?: String, comment?: String}} source provenance of the assertion.
 * @property {String} evidence supporting evidence URI, or "".
 */

/**
 * A resolved entity, DEER-shaped: identity keys raw, every other property a
 * ValueObject or an Array of them.
 *
 * @typedef {Object} ShapedEntity
 * @property {URI} [@id]
 * @property {URI} [id]
 * @property {String} [@type]
 * @property {String} [type]
 * @property {RerumMetadata} [__rerum]
 */

/**
 * The projection option on the read paths (antlers#12): name the properties a
 * consumer wants and identity keys are kept beyond those; absent keys are
 * absent, never invented.
 *
 * @typedef {Object} ReadOptions
 * @property {Boolean} [fresh=false] bust the HTTP cache — read-after-write.
 * @property {String[]|String} [properties] project the result down to these
 * properties plus identity keys.
 */

/**
 * One structured log record, as a config.log sink receives it (antlers#8).
 *
 * @typedef {Object} LogRecord
 * @property {"debug"|"info"|"warn"|"error"} level the record's weight.
 * @property {String} code the stable identifier, `module.topic` kebab-case.
 * @property {String} message human-readable.
 * @property {Object} detail structured data for filters and tooling.
 * @property {Number} at epoch ms the record was built.
 */

/**
 * The deployment configuration (js/core/config.js).  Tag parameters `@param {DEERConfig}`
 * only when the WHOLE object is taken — most call sites read one key.
 *
 * @typedef {Object} DEERConfig
 * @property {Object} URLS the TinyNode proxy endpoints.
 * @property {String[]} ID_BASES RERUM URI prefixes — the write boundary.
 * @property {String[]} READ_ID_BASES foreign bases a read may reach (antlers#9).
 * @property {String} GENERATOR the agent this deployment writes with.
 * @property {String[]|null} [READ_GENERATORS] the agents whose annotations a read gathers; null is exhibit mode (antlers#9).
 * @property {String[]} TARGET_KEYS the properties an Annotation may carry its target URI under (antlers#9).
 * @property {String} [BASE] base for resolving relative URLS.
 * @property {Number} LIMIT page size for paged queries.
 * @property {Number} SKIP paged queries start offset.
 * @property {Number} MAX_LIMIT RERUM's own limit ceiling, a guard.
 * @property {Number} MAX_RESULTS runaway-paging backstop.
 * @property {Boolean} DEBUG verbose library logging.
 * @property {"debug"|"info"|"warn"|"error"|"silent"} [LOG_LEVEL] the log gate; unset follows DEBUG (antlers#8).
 * @property {function(LogRecord): void} [log] injectable log sink (antlers#8).
 * @property {Function} [fetch] injectable fetch for hosts and instrumentation.
 */

/**
 * The result of a clientRead: the entity RAW and the scoped-leaf annotations
 * targeting it, also RAW.
 *
 * @typedef {Object} ClientRead
 * @property {RerumDocument} entity the resolved entity document.
 * @property {Annotation[]} annotations the scoped leaves, ready to merge.
 */

/**
 * A write operation as the offline queue stores it and replays it
 * (js/deer-offline.js).  The exact request that would have been sent online.
 *
 * @typedef {Object} QueuedWrite
 * @property {String} method the HTTP method.
 * @property {String} url the proxy endpoint.
 * @property {Object} body the document to write.
 * @property {URI|null} targetId the entity the write targets, when known.
 * @property {String} status "pending" | "synced" | "error".
 * @property {Number} queueId enqueue order.
 * @property {Number} enqueuedAt epoch ms.
 */

