"""Digestive Oncology practice-specialty LLM agents and dynamic TNCD resource selector."""

from __future__ import annotations

from collections.abc import Mapping
from types import MappingProxyType

from src.domain.common.agents import Agents as AgentsCommon
from src.domain.common.common_ressources import PrimaryOrganEnum

DEFAULT_TNCD_RESOURCES: tuple[str, ...] = ()

TNCD_BY_ORGAN: Mapping[PrimaryOrganEnum, tuple[str, ...]] = MappingProxyType(
    {
        PrimaryOrganEnum.oesophagus: ("TNCDOESOPHAGE.pdf",),
        PrimaryOrganEnum.stomach: ("TNCDESTOMAC.pdf",),
        PrimaryOrganEnum.colon: ("TNCDCOLON.pdf", "TNCDCOLORECTALMETA.pdf"),
        PrimaryOrganEnum.rectum: ("TNCDRECTUM.pdf", "TNCDCOLORECTALMETA.pdf"),
        PrimaryOrganEnum.liver: ("TNCDCHC.pdf",),
        PrimaryOrganEnum.intra_hepatic_bile_duct: ("TNCDVOIESBILIAIRES.pdf",),
        PrimaryOrganEnum.extra_hepatic_bile_duct: ("TNCDVOIESBILIAIRES.pdf",),
        PrimaryOrganEnum.pancreas: ("TNCDPANCREAS.pdf",),
    }
)


def resolve_oncology_resources(
    organ: PrimaryOrganEnum | str | None,
) -> list[str]:
    """Return the organ-specific TNCD PDF(s), or `[]` when `unknown`/unrecognized."""
    if not organ:
        return list(DEFAULT_TNCD_RESOURCES)
    try:
        return list(TNCD_BY_ORGAN.get(PrimaryOrganEnum(organ), DEFAULT_TNCD_RESOURCES))
    except ValueError:
        return list(DEFAULT_TNCD_RESOURCES)


class Agents(AgentsCommon):
    """Digestive Oncology practice-specialty agents."""

    class Digestive_surgeon_expert_agent(AgentsCommon.Expert_model):
        agent_name: str = "digestive surgeon expert"
        expert_type = (
            "digestive oncology surgery (resectability assessment, vascular contact, "
            "surgical margins R0/R1, perioperative morbidity, and surgical indication)"
        )
        ressources: list[str] = list(DEFAULT_TNCD_RESOURCES)

    class Medical_oncologist_expert_agent(AgentsCommon.Expert_model):
        agent_name: str = "medical oncologist expert"
        expert_type = (
            "digestive medical oncology (neoadjuvant, induction, adjuvant, and palliative "
            "systemic chemotherapy, targeted therapy, immunotherapy, biomarkers, and DPD/OMS fitness)"
        )
        ressources: list[str] = list(DEFAULT_TNCD_RESOURCES)

    class Radiation_oncologist_expert_agent(AgentsCommon.Expert_model):
        agent_name: str = "radiation oncologist expert"
        expert_type = (
            "digestive radiation oncology (neoadjuvant/definitive chemoradiotherapy, total "
            "neoadjuvant therapy, stereotactic body radiation therapy, and consolidative/palliative radiotherapy)"
        )
        ressources: list[str] = list(DEFAULT_TNCD_RESOURCES)

    class Radiologist_expert_agent(AgentsCommon.Expert_model):
        agent_name: str = "radiologist expert"
        expert_type = (
            "digestive oncologic radiology (CT/MRI/PET staging, RECIST 1.1 response, "
            "vascular involvement, missing imaging exams, and external imaging re-reading needs)"
        )
        ressources: list[str] = list(DEFAULT_TNCD_RESOURCES)

    class Gastroenterologist_expert_agent(AgentsCommon.Expert_model):
        agent_name: str = "gastroenterologist expert"
        expert_type = (
            "digestive gastroenterology, interventional endoscopy, and hepatology "
            "(EUS/biopsy, biliary or digestive stenting/drainage, portal hypertension, "
            "Child-Pugh hepatic reserve, and nutritional/endoscopic support)"
        )
        ressources: list[str] = list(DEFAULT_TNCD_RESOURCES)

    class Pathologist_expert_agent(AgentsCommon.Expert_model):
        agent_name: str = "pathologist expert"
        expert_type = (
            "digestive anatomical and molecular pathology (histological subtype, differentiation "
            "grade, pTNM/ypTNM staging, resection margins, MMR/MSI, RAS/BRAF, HER2, PD-L1 CPS, "
            "and diagnostic biopsy adequacy)"
        )
        ressources: list[str] = list(DEFAULT_TNCD_RESOURCES)
