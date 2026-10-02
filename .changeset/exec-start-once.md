---
'@aivi/host': patch
---

The exec door takes **one start per connection, even from a client that
sends two before the pty import lands**: a start now claims the session
before its first await, so the second frame is answered `start sent twice`
and spawns nothing. Before this, two frames racing the import built two
children with the operator's bearer, and only the one the session holds had
a kill handle — the sibling ran past every stop.
