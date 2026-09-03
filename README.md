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
