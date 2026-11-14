"""Spinal Muscular Atrophy (SMA) specialty LLM agents and default PNDS resources."""

from __future__ import annotations

from src.domain.common.agents import Agents as AgentsCommon

DEFAULT_SMA_RESOURCES: tuple[str, ...] = (
    "amyotrophie_spinale_infantile_-_argumentaire.pdf",
    "amyotrophie_spinale_infantile_-_pnds.pdf",
    "synthese_mg_amyotrophie_spinale_infantile.pdf",
)


class _SmaExpertBase(AgentsCommon.Expert_model):
    """Shared base for SMA specialty experts using standard `Expert_model.get_catalog_resources`."""

    ressources: list[str] = list(DEFAULT_SMA_RESOURCES)


class Agents(AgentsCommon):
    class Neurologist_expert_agent(_SmaExpertBase):
        agent_name: str = "neurologist expert"
        expert_type = "neurological diseases / spinal muscular atrophy"

    class Geneticist_expert_agent(_SmaExpertBase):
        agent_name: str = "geneticist expert"
        expert_type = "genetics / genetic mutations"

    class Pulmonologist_expert_agent(_SmaExpertBase):
        agent_name: str = "pulmonologist expert"
        expert_type = "respiratory diseases / pulmonology"

    class Physiotherapy_expert_agent(_SmaExpertBase):
        agent_name: str = "physiotherapy expert"
        expert_type = "physical medicine and rehabilitation"

    class Orthopedist_expert_agent(_SmaExpertBase):
        agent_name: str = "orthopedist expert"
        expert_type = "orthopedic diseases and spine deformities"
