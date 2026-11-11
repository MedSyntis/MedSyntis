import os
import yaml
from yaml.loader import SafeLoader
import streamlit_authenticator as stauth


def main():
    """Interactive CLI utility to add or update a local Streamlit authenticator user."""
    print("--- MedSyntis: Add or update a user ---")

    username = input("Username: ").strip()
    if not username:
        print("Error: Username cannot be empty.")
        return

    name = input("Full name (e.g. Dr. Martin): ").strip()
    email = input("Email address: ").strip()
    password = input("Password: ").strip()

    if not password:
        print("Error: Password cannot be empty.")
        return

    # Hash the password using bcrypt via streamlit-authenticator
    print("Generating secure password hash...")
    hashed_password = stauth.Hasher.hash(password)

    # Resolve configuration file path via AppConfig
    try:
        import sys

        script_dir = os.path.dirname(os.path.abspath(__file__))
        sys.path.insert(0, os.path.abspath(os.path.join(script_dir, "..")))
        from src.application.config import AppConfig

        app_config = AppConfig()
        config_path = app_config.auth_config_path
    except Exception:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        config_path = os.path.abspath(
            os.path.join(script_dir, "..", "config", "auth_config.yaml")
        )

    if not os.path.exists(config_path):
        print(f"Error: Configuration file {config_path} does not exist.")
        return

    # Read existing configuration
    with open(config_path, "r", encoding="utf-8") as file:
        config = yaml.load(file, Loader=SafeLoader)

    # Initialize nested credential mappings if missing
    if "credentials" not in config or config["credentials"] is None:
        config["credentials"] = {}
    if (
        "usernames" not in config["credentials"]
        or config["credentials"]["usernames"] is None
    ):
        config["credentials"]["usernames"] = {}

    # Add or update user entry
    config["credentials"]["usernames"][username] = {
        "email": email,
        "name": name,
        "password": hashed_password,
    }

    # Write updated configuration back to disk
    with open(config_path, "w", encoding="utf-8") as file:
        yaml.dump(
            config, file, default_flow_style=False, sort_keys=False, allow_unicode=True
        )

    print(f"\nSuccess! User '{username}' has been added/updated in {config_path}.")


if __name__ == "__main__":
    main()
