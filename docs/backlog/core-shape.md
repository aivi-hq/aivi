# Colors out of core; core's shape

Status: unscheduled, raised by the operator 2026-10-02 while reviewing core.

**The colors.** `brand.ts` and `output.ts` carry styleText formatting —
brand colors, bold, table rendering — inside `@aivi/core`, the package every
other package depends on for *facts*. Styling is presentation: it belongs in
its own package (or at least out of the package the config schema and the
project model live in). Nobody has asked for it yet; that is why it is still
in core. When it moves, `OutputBlock.colors` and the `print` decision move
with it.

**The smell around it.** Core today is: config schema, project model, log,
output rendering, brand, clocks, tool/task descriptor shapes, kinds. The
types are genuinely shared — the config schema is the installation's truth
and both host and kit speak it — but the *rendering* pieces (colors, tables)
read as utils that happened to land there first. The standing question when
each piece next changes: is this a shared contract (stays) or a utility
(moves out)? The colors are the first known answer.
