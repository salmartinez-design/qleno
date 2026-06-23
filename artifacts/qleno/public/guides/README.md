# Help & Guides — screenshot assets

Each guide's screenshots live in their own folder here:

```
public/guides/<guide-slug>/step-1.png
public/guides/<guide-slug>/step-2.png
...
```

- These are served at `/guides/<guide-slug>/step-N.png` (the `image` field on each
  guide step points here).
- Use **portrait phone screenshots** for tech guides (capture at ~390pt logical
  width). PNG preferred; JPG is also supported.
- File names are arbitrary but `step-N.png` keeps them ordered and obvious.
- No real customer PII in screenshots — use test data.
- The slug must match the guide's `slug` column.

The captions (EN + ES) and the `image` path live in the `guides` DB row, not in
code — see the seed in `artifacts/api-server/src/lib/guides-migrate.ts` for the
shape. Adding/replacing screenshots here + updating the DB row needs no code
change.
