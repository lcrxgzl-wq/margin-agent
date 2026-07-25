# @margin/domain

Revision audit model: immutable Proposal + Decision + ApplyEvent.

## Concepts

- **Proposal**: model suggestion (immutable once `proposed`)
- **Decision**: user Y / N / E (E carries edited text without mutating proposal)
- **ApplyEvent**: CAS write result against document revision/hash

`schemaVersion: 1`
