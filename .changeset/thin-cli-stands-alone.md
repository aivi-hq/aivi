---
'@aivi/cli': patch
---

The published `aivi` died on any command: the help banner imported
`@aivi/core`, which resolves only inside the workspace hoist, never in an
installed package. The banner now ships inside the thin CLI, a unit test
refuses any import that is not a declared dependency, and `npm run pack:smoke`
(now part of `npm run check`) installs the packed tarball alone and runs the
binary — help, version, and the no-home path — before a release can pass the
gate.
