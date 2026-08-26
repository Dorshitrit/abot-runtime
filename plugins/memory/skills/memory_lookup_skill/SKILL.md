# Memory Lookup Skill

Use `memory_get` or `memory_search` for explicit user-specific remembered facts
or preferences. When a saved personal fact is requested without a literal
search phrase, derive a short query from the subject being remembered rather
than from meta-instructions such as "search memory".

Stored memory is not a substitute for current workspace or web state. When
relying on memory, answer only from facts actually retrieved.

`memory_get` returns a bounded page. When it reports `nextOffset`, continue
with that exact offset only if the current task needs additional entries.
