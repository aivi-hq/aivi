# @aivi/host

## 0.2.0

### Minor Changes

- [#2](https://github.com/aivi-hq/aivi/pull/2) [`6a44b29`](https://github.com/aivi-hq/aivi/commit/6a44b29d5b9d04b30a613debad1fefe21a9c114c) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Roles arrive: a person carries an open string array of roles (`operator`
  manages people and maintenance; new people default `member`), the store
  migration grants `operator` to everyone who existed, and `whoami` answers the
  real roles instead of the hardcoded stub. People management over the API —
  listing, creating (optionally with roles: `aivi people create NAME --role
  operator`) and minting tokens for — now requires an operator bearer; the
  store-direct path on the server itself stays the operator at the console.
  Wider per-operation enforcement lands with the ops dispatcher
  (docs/plans/operator-api.md).

### Patch Changes

- Updated dependencies [[`6a44b29`](https://github.com/aivi-hq/aivi/commit/6a44b29d5b9d04b30a613debad1fefe21a9c114c), [`05ec0d6`](https://github.com/aivi-hq/aivi/commit/05ec0d68a50c678c32882d6ad720db60cb8e01c7)]:
  - @aivi/core@0.2.0
