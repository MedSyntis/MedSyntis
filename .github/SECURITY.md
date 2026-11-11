# Security Policy — MedSyntis

## Supported Versions

Security updates and vulnerability remediations are actively maintained on the `main` branch and the latest container releases (`medsyntis-web`, `medsyntis-api`, and `medsyntis`).

| Version / Branch | Supported |
| :--- | :--- |
| `main` (latest) | ✅ Yes |
| Older commits / unmaintained branches | ❌ No |

---

## Reporting a Vulnerability (Responsible Disclosure)

Please **DO NOT** open a public GitHub Issue or public Pull Request for suspected security vulnerabilities, authentication bypasses, container privilege escalations, or data-isolation flaws.

Instead, report vulnerabilities privately through **GitHub Private Vulnerability Reporting** (Security Advisories):

1. Navigate to the repository's **Security** tab on GitHub (`Security` -> `Advisories` -> `Report a vulnerability`).
2. Provide a concise technical description including:
   - Affected component (`web/` Fastify BFF, `application/` FastAPI/RAG backend, `dist/docker/` Compose/Caddy/OAuth2-Proxy, or CI/CD).
   - Minimal reproduction steps or proof-of-concept (using **100% synthetic data**).
   - Potential security, clinical, or regulatory impact.

### Response Timeline
- **Initial acknowledgment**: within **48 hours**.
- **Triage & severity assessment**: within **5 business days**.
- **Remediation & coordinated disclosure**: critical/high vulnerabilities are prioritized immediately before public disclosure.

---

## Strict Zero-PHI Rule (GDPR / CNIL / HDS / Medical Confidentiality)

> [!CAUTION]
> **NEVER include Protected Health Information (PHI) or real patient data** in security reports, logs, screenshots, HTTP captures, or sample PDFs.
> In accordance with the **European GDPR (RGPD)**, **French Public Health Code (Art. L. 1110-4 & L. 1111-8 CSP — HDS)**, and **PGSSI-S**, all diagnostic artifacts submitted to maintainers MUST exclusively use **synthetic or fully anonymized fictitious test data**.
