---
trigger: always_on
---

- must verify prek pass
- must use sonarlint
- must pass ruff format
- must pass vitest
- never use `os.environ` directly in application code; always use `BaseSettings` / `AppConfig`
