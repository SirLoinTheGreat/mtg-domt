# Vendored Runtime Libraries

Third-party JS libraries bundled with the gallery. These are **runtime** dependencies served to visitors, distinct from the developer tooling under `tools/` (which is gitignored).

We vendor (rather than CDN-link) so the gallery is self-contained and offline-capable.

## Inventory

| Package | Version | Source | License | Pulled |
|---|---|---|---|---|
| client-zip | 2.x | https://cdn.jsdelivr.net/npm/client-zip@2/index.js | MIT | 2026-04-26 |

## Refreshing a vendored file

Re-download from the URL in the table above. Verify the file is a JS module (not an HTML error page) and roughly the expected size, then run a Node import smoke test:

```bash
node --input-type=module -e "import('./assets/vendor/<file>').then(m => console.log(Object.keys(m)))"
```

Update the "Pulled" date in the table.
