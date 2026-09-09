---
category: Changed
---
- The bundled preset set shrinks from 7 to 5 roles: `designer` and `librarian` are no longer auto-declared on apply. Rows saved by earlier versions keep their persona and survive untouched, but they now show source `user` — even though the operator never wrote those rows — and lose the seeded badge / revert affordance, becoming ordinary config rows again.
