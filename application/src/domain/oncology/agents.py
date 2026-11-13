"""Digestive Oncology practice-specialty LLM agents and dynamic TNCD resource selector."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
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


class _OncologyExpertBase(AgentsCommon.Expert_model):
    """Shared base for Oncology specialty experts with automated organ-scoped TNCD catalog."""

    ressources: list[str] = list(DEFAULT_TNCD_RESOURCES)

    @classmethod
    def get_catalog_resources(
        cls,
        available_files: Sequence[str] | None = None,
    ) -> dict[str, list[str]]:
        """Return the automated organ -> TNCD guideline mapping for Oncology specialists."""
        _ = available_files
        return {organ.value: list(pdfs) for organ, pdfs in TNCD_BY_ORGAN.items()}


class Agents(AgentsCommon):
    """Digestive Oncology practice-specialty agents."""

    class Digestive_surgeon_expert_agent(_OncologyExpertBase):
        agent_name: str = "digestive surgeon expert"
        expert_type = (
            "digestive oncology surgery (resectability assessment, vascular contact, "
            "surgical margins R0/R1, perioperative morbidity, and surgical indication)"
        )

    class Medical_oncologist_expert_agent(_OncologyExpertBase):
        agent_name: str = "medical oncologist expert"
        expert_type = (
            "digestive medical oncology (neoadjuvant, induction, adjuvant, and palliative "
            "systemic chemotherapy, targeted therapy, immunotherapy, biomarkers, and DPD/OMS fitness)"
        )

    class Radiation_oncologist_expert_agent(_OncologyExpertBase):
        agent_name: str = "radiation oncologist expert"
        expert_type = (
            "digestive radiation oncology (neoadjuvant/definitive chemoradiotherapy, total "
            "neoadjuvant therapy, stereotactic body radiation therapy, and consolidative/palliative radiotherapy)"
        )

    class Radiologist_expert_agent(_OncologyExpertBase):
        agent_name: str = "radiologist expert"
        expert_type = (
            "digestive oncologic radiology (CT/MRI/PET staging, RECIST 1.1 response, "
            "vascular involvement, missing imaging exams, and external imaging re-reading needs)"
        )

    class Gastroenterologist_expert_agent(_OncologyExpertBase):
        agent_name: str = "gastroenterologist expert"
        expert_type = (
            "digestive gastroenterology, interventional endoscopy, and hepatology "
            "(EUS/biopsy, biliary or digestive stenting/drainage, portal hypertension, "
            "Child-Pugh hepatic reserve, and nutritional/endoscopic support)"
        )

    class Pathologist_expert_agent(_OncologyExpertBase):
        agent_name: str = "pathologist expert"
        expert_type = (
            "digestive anatomical and molecular pathology (histological subtype, differentiation "
            "grade, pTNM/ypTNM staging, resection margins, MMR/MSI, RAS/BRAF, HER2, PD-L1 CPS, "
            "and diagnostic biopsy adequacy)"
        )
