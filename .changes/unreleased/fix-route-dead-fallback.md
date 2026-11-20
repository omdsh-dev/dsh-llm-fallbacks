---
category: Fixed
---
- A misconfigured model id (`UNKNOWN_MODEL`), an unusable credential (`MISSING_CREDENTIAL` / `INVALID_CREDENTIAL` / `NO_CREDENTIAL_STORE` / `ACCOUNT_SIGN_IN_REQUIRED` / `ACCOUNT_TOKEN_INVALID`), a route that cannot serve the request's shape (`MODEL_UNSUPPORTED` / `UNSUPPORTED_OPTION` / `UNSUPPORTED_CONTENT`), and a non-transient credential-refresh `INVALID_REQUEST` (expired OAuth grant, promoted to `AUTH`) now advance the chain without needing a `triggerCodes` entry, so one dead head no longer ends the whole run with healthy candidates behind it; a transient refresh failure (network / timeout / 429 / 5xx) still stays with llm-retry.
