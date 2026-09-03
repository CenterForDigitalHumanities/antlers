# deer
An html template system for various interface types that connect to RERUM to save JSON or JSON-LD data types.
Templates follow encoding standards like those found at https://schema.org/docs/schemas.html.

## Interoperability

DEER dereferences resources by URI and renders JSON-LD-shaped objects (`@id`, `@type`, `@context`).
RERUM is the default and authoritative backend for persistence and Web Annotation-style
annotation discovery.

Because the dereference step is isolated behind a single read-resource hook, DEER can also
load **public** JSON-LD resources from other systems — including public Solid Pod resources
(https://solidproject.org/) — without any other change. To read a protected or non-JSON
resource, override `DEER.READ_RESOURCE` with a custom reader that owns URL handling,
auth headers, and content negotiation:

```js
import { default as DEER } from './deer-config.js'

// Example: read a public Solid resource with a JSON-LD content type.
DEER.READ_RESOURCE = (id) =>
    fetch(id, { headers: { Accept: 'application/ld+json' } })
        .then(response => response.json())
```

Scope of this integration:

- **Supported:** read-only loading of public JSON/JSON-LD resources by URI.
- **Not implied:** authenticated Pod access, Pod writes, container discovery, permissions,
  or Turtle/RDF serialization. RERUM remains the write and annotation backend.

## Offline Mode

DEER supports a transparent offline mode so users can keep working when the network is
unavailable. It is implemented in `js/deer-offline.js` and initialized automatically by
`js/deer.js`.

**Reading.** Entities are cached in IndexedDB (keyed by `@id`/`id`, stamped with the time
they were last seen). When offline, views and `UTILS.expand()` render from the cache instead
of fetching. An element rendered from cache is marked stale via `data-deer-stale="true"` and
`data-deer-cached-at="<epoch ms>"`, and a `deer-stale` event is dispatched.

**Writing.** All writes — annotation CREATE/UPDATE, and `simpleUpsert` CREATE/OVERWRITE — are
attempted online first. When offline (or when the request fails), the exact request is queued
in an IndexedDB outbox. When connectivity returns, queued writes are replayed in enqueue order;
the first failure stops the replay to preserve ordering and is surfaced as an error.

**Status.** Connectivity is exposed through events and document attributes so applications can
render state without polling:

| Signal | Meaning |
| --- | --- |
| `deer-online` / `deer-offline` | Connectivity changed. `document.documentElement[data-deer-online]` mirrors it. |
| `deer-queued` | A write was queued while offline. `detail.pending` is the pending count. |
| `deer-synced` | Queued writes were replayed. `detail.synced` is the number synced. |
| `deer-stale` | An element was rendered from cache. `detail.cachedAt` is the cache timestamp. |

**Limitations.**

- IndexedDB is unavailable in some contexts (e.g. `file://`, some private-browsing modes); the
  module degrades gracefully and logs a warning rather than throwing.
- When an entity **create** is queued offline, its annotations are not queued in the same pass,
  because they target the created entity's `@id`, which does not exist yet. A warning is emitted;
  those annotations must be resubmitted once the entity has an id.
- Conflict handling is last-writer-wins via RERUM's versioned writes; DEER does not merge
  concurrent edits.
