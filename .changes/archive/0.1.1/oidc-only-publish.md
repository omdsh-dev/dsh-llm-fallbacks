---
category: Changed
---
- npm publishing is now pure OIDC (Trusted Publishing): the bootstrap `NODE_AUTH_TOKEN` mode and the optional secret env were removed after the npm-side trusted publisher was configured; `npm publish --provenance` authenticates entirely via the GitHub OIDC id-token.
