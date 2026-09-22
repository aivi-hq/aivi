# @aivi/app

## 0.2.1

### Patch Changes

- [#7](https://github.com/aivi-hq/aivi/pull/7) [`5ea68da`](https://github.com/aivi-hq/aivi/commit/5ea68da80aaa108a5d43131eb983300496e6c3f4) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - `server create` becomes the identity step behind `aivi setup` and its output feeds the flow instead of addressing the person: the `next` instructions name commands that exist (`aivi setup`, `aivi serve`). `aivi people create` on a terminal offers to mint the person's token right away — the common reason to create a person.

- [#7](https://github.com/aivi-hq/aivi/pull/7) [`12dd432`](https://github.com/aivi-hq/aivi/commit/12dd432b92d028b0459ffa450707b3d2b0be3831) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Declare `@aivi/browser` as a dependency: `serve` imports it on the default path (skipped only with `browser: false`), so a fresh `npm install @aivi/app` died with `Cannot find package '@aivi/browser'` before the host ever listened. The monorepo's workspace links hid the gap; an installed home does not have them.

## 0.2.0

### Minor Changes

- [#2](https://github.com/aivi-hq/aivi/pull/2) [`9fe5d9e`](https://github.com/aivi-hq/aivi/commit/9fe5d9e167d71c7a1d232452dde4872c9e314a73) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The channel and browser packages are no longer dependencies of `@aivi/app`:
  each module's package loads when its config block enables it, so an
  installation without a channel package runs every other command untouched.
  Linear client resolution moved to `@aivi/linear` (`clientFor`).

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
  - @aivi/host@0.2.0
  - @aivi/core@0.2.0
  - @aivi/knowledge@0.1.1
