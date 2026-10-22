# lock-by-owning-state

A state may own variables (`locks:`): only it can change them, so a value changes by going back there. A reset frees the locks the agent set. See bench-runtime-findings 5b.
