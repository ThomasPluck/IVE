# Grounding evaluation corpus

Seeds the evaluation harness required by `spec §8`: a growing set of
`function → summary → claim-labels` triples that let CI compute the
entailment gate's precision and recall and fail the build on
regression.

## Format

Each test case is one JSON file:

```json
{
  "id": "py/requests_get",
  "language": "python",
  "facts": [
    { "id": "f1", "kind": "call", "content": "calls requests.get" },
    { "id": "f2", "kind": "return_type", "content": "returns str" }
  ],
  "summary": "Fetches the URL via requests.get and returns the response body as a string. Persists the result to Redis.",
  "labels": [
    { "sentence": "Fetches the URL via requests.get and returns the response body as a string.", "entailed": true },
    { "sentence": "Persists the result to Redis.",                                              "entailed": false }
  ]
}
```

## Targets

- `precision ≥ 0.9` — the gate rarely marks a true claim as unentailed.
  Striking through a real claim misleads the user worse than missing a
  fake one.
- `recall ≥ 0.7` — the gate catches the majority of unsupported
  claims.

Bumping **either** threshold is a deliberate decision; lowering either
blocks the PR.

## Growing the corpus

The spec asks for **100 hand-labeled pairs**. Each merged PR is
encouraged to add a handful. When adding a case:

1. Run the function's summary through the daemon so you know the real
   fact list.
2. Write the summary as a sequence of short sentences, one claim each.
3. For every sentence, flip `entailed` to `true` only when *some* fact
   directly supports it.
4. Keep sentences to `< 160` chars so token overlap gives a fair read.

The harness lives at `daemon/tests/grounding_eval.rs` and runs on
`cargo test`.
