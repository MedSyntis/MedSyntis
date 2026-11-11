import os
from typing import TYPE_CHECKING, Any

from src.domain.common.agents import Agents as BaseAgents
from src.domain.oncology.agents import Agents as OncologyAgents
from src.domain.sma.agents import Agents as SmaAgents

_DOMAIN_AGENTS_MAP: dict[str, type[BaseAgents]] = {
    "oncology": OncologyAgents,
    "sma": SmaAgents,
}


def get_domain_agents_cls(domain: str | None = None) -> type[BaseAgents]:
    """Return the domain-specific `Agents` registry class."""
    target = (domain or os.environ.get("APP_DOMAIN") or "oncology").strip().lower()
    if target not in _DOMAIN_AGENTS_MAP:
        raise ValueError(
            f"Domain '{target}' not found. Available domains: {list(_DOMAIN_AGENTS_MAP.keys())}"
        )
    return _DOMAIN_AGENTS_MAP[target]


def get_domain_agents(domain: str | None = None) -> BaseAgents:
    """Instantiate the domain-specific `Agents` registry."""
    cls = get_domain_agents_cls(domain)
    return cls()


if TYPE_CHECKING:
    Agents = BaseAgents


def __getattr__(name: str) -> Any:
    """Dynamically resolve `Agents` without freezing `os.environ` at import time."""
    if name == "Agents":
        return get_domain_agents_cls()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = [
    "Agents",
    "BaseAgents",
    "OncologyAgents",
    "SmaAgents",
    "get_domain_agents",
    "get_domain_agents_cls",
]
