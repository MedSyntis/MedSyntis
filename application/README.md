# 🖥️ MedSyntis — Python Backend & Streamlit Dashboard

<p align="left">
  <a href="https://www.python.org/"><img src="https://img.shields.io/badge/Python-%3E%3D%203.13-3776AB?style=flat-square&logo=python&logoColor=white" alt="Python Version" /></a>
  <a href="https://streamlit.io/"><img src="https://img.shields.io/badge/Frontend-Streamlit%201.66.1+-FF4B4B?style=flat-square&logo=streamlit&logoColor=white" alt="Streamlit" /></a>
  <a href="tests"><img src="https://img.shields.io/badge/Tests-Pytest%20Passing-brightgreen?style=flat-square&logo=pytest&logoColor=white" alt="Tests Status" /></a>
  <a href="https://github.com/astral-sh/ruff"><img src="https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/astral-sh/ruff/main/assets/badge/v2.json&style=flat-square" alt="Ruff Linter" /></a>
  <a href="../README.md"><img src="https://img.shields.io/badge/Privacy-100%25%20Local%20First-2ea44f?style=flat-square&logo=shield&logoColor=white" alt="Local First" /></a>
</p>

This directory (`application/`) contains the **MedSyntis** Cross-Domain FastAPI backend (`app-api.py`), the DDD/Hexagonal clinical extraction engine (`src/`), and the **Streamlit** dashboard (`app-ui.py`).

## 🚀 Running the Application

To start the MedSyntis Cross-Domain REST & SSE API locally in development mode from `application/`:
```bash
uv run python app-api.py
```

To start the MedSyntis Streamlit UI locally in development mode from `application/`:
```bash
uv run streamlit run app-ui.py
```

---

## 🔐 Authentication System

MedSyntis requires authentication to access patient records. Authentication runs locally via `streamlit-authenticator` (`APP_AUTH_MODE=local`) or behind a zero-trust reverse proxy (`APP_AUTH_MODE=oauth_proxy` with `X-MedSyntis-Proxy-Secret`).

### Configuration File (`application/config/auth_config.yaml`)
The `application/config/auth_config.yaml` file (or `application/config/auth_config_dev.yaml` in development mode) stores user credentials and session cookie parameters (`medsyntis_auth_cookie`).

#### Default Development Credentials:
* **Username**: `admin`
* **Password**: `admin`

### Adding or Updating a User
Passwords in `application/config/auth_config.yaml` must be hashed with Bcrypt. Use the interactive CLI utility to add or update users directly in the YAML configuration file:

1. Run the interactive user management script from the repository root (or `application/`):
   ```bash
   uv run --project application python application/scripts/add_user.py
   ```
2. Enter the prompted details (username, full display name, email address, and password).
3. The script automatically generates a secure Bcrypt hash and writes it to `application/config/auth_config.yaml`.
