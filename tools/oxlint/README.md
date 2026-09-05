# Local lint rules

`anti-slop/` is vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) at commit `e8c4880471b23ab7f216fba7b27d173a6ef07d4c`, using its install skill script. It contains the runtime plugin sources, not upstream rule tests. The upstream MIT license is included.

All 15 generic rules and the Effect rule are enabled in `oxlint.config.ts`. The Effect rule checks relative service-constructor imports, not package aliases.

Keep `oxlint` and `@oxlint/plugins` pinned to the same exact version. Review upstream changes before updating the vendored copy. Vendored sources and agent assets are excluded from linting and formatting.

The formatter follows [the supplied gist](https://gist.github.com/guidefari/67636c73587ab25597794f5b48eed089): no semicolons, single quotes, 100-column width, and grouped imports. Its old `experimentalSortImports` key is named `sortImports` in the installed oxfmt schema; the configuration uses that current key and the local schema.
