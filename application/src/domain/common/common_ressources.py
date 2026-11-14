from enum import Enum, IntEnum
from datetime import date, datetime
import re

from typing import Annotated, Any, ClassVar, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, PastDate, field_validator

MarkdownStr = Annotated[
    str,
    Field(json_schema_extra={"format": "markdown", "markdown": True}),
]


def _coerce_clinical_date(v: Any) -> Optional[date]:
    """
    Coerce clinical date inputs (`date`, `datetime`, ISO strings, French `DD/MM/YYYY`,
    or `YYYY`) into a `datetime.date`, returning `None` for empty/unparseable values.
    """
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    if isinstance(v, str):
        s = v.strip()
        if not s or s.lower() in (
            "n/a",
            "na",
            "none",
            "null",
            "inconnu",
            "inconnue",
            "non précisé",
            "non précise",
        ):
            return None
        try:
            return datetime.fromisoformat(s).date()
        except ValueError:
            pass
        # French format DD/MM/YYYY or DD-MM-YYYY
        m_fr = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$", s)
        if m_fr:
            try:
                return date(int(m_fr.group(3)), int(m_fr.group(2)), int(m_fr.group(1)))
            except ValueError:
                return None
        # Year-month YYYY-MM or MM/YYYY
        m_ym = re.match(r"^(\d{4})[/.-](\d{1,2})$", s)
        if m_ym:
            try:
                return date(int(m_ym.group(1)), int(m_ym.group(2)), 1)
            except ValueError:
                return None
        m_my = re.match(r"^(\d{1,2})[/.-](\d{4})$", s)
        if m_my:
            try:
                return date(int(m_my.group(2)), int(m_my.group(1)), 1)
            except ValueError:
                return None
        # Year only YYYY
        m_y = re.match(r"^(\d{4})$", s)
        if m_y:
            try:
                return date(int(m_y.group(1)), 1, 1)
            except ValueError:
                return None
    return v


class RadiologicExamType(str, Enum):
    CT = "CT"
    MRI = "MRI"
    PET = "PET"
    EUS = "EUS"


class Gender(str, Enum):
    male = "Male"
    female = "Female"
    other = "Other"
    not_given = "Not_given"


class RevealingMode(str, Enum):
    """
    This class lists the ways in which the tumor can be revealed
    """

    symptoms = "symptoms"
    incidental_radiologic = "incidental radiologic finding"
    incidental_biologic = "incidental biologic finding"
    follow_up = "follow up"
    unknown = "unknown"


class MetastaticLocationsEnum(str, Enum):
    """
    This class lists possible metastatic sites
    """

    liver = "liver"
    lung = "lung"
    peritoneal = "peritoneal"
    bone = "bone"
    brain = "brain"
    other = "other"


class WHOPerformanceStatus(int, Enum):
    _0 = 0
    _1 = 1
    _2 = 2
    _3 = 3
    _4 = 4

    @classmethod
    def labels(cls) -> dict:
        return {
            cls._0: "No limitation of activities (none)",
            cls._1: "Limitation in strenuous activities, but able to do light work or other activities",
            cls._2: "Considerable limitation in activities; some assistance occasionally needed",
            cls._3: "Severe limitation in activities; frequent assistance required",
            cls._4: "Complete limitation of activities; unable to perform any activity",
        }


class PrimaryOrganEnum(str, Enum):
    pancreas = "Pancreas"
    colon = "Colon"
    liver = "Liver"
    stomach = "Stomach"
    oesophagus = "Oesophagus"
    rectum = "Rectum"
    intra_hepatic_bile_duct = "Intra-hepatic bile duct"
    extra_hepatic_bile_duct = "Extra-hepatic bile duct"
    unknown = "unknown"

    @classmethod
    def _missing_(cls, value: object) -> Optional["PrimaryOrganEnum"]:
        if isinstance(value, str):
            cleaned = value.strip().lower()
            for member in cls:
                if cleaned in (member.value.lower(), member.name.lower()):
                    return member
        return None


class TNCDCancerTypesEnum(str, Enum):
    ampulloma = "tumor of the ampulla of Vater"
    localized_colon_cancer = "localized colon cancer, without distant metastasis"
    metastatic_colorectal = "metastatic colorectal cancer"
    rectum = "rectal cancer"
    anal_canal = "anal canal cancer"
    liverhcc = "hepatocellular carcinoma (primary liver cancer)"
    biliary_tract = "biliary tract cancer"
    pancreas = "pancreatic cancer"

    gastric = "gastric cancer"
    oesophagus_junction = "oesophagus and esophagogastric junction cancer"
    unknown = "unknown cancer type"


class CancerTypesEnum(str, Enum):
    colorectal_cancer = "rectum and colon primitive cancer"
    liver_primary_cancer = "hepatocellular carcinoma (primary liver cancer)"
    biliary_tract_cancer = "biliary tract cancer"
    pancreatic_cancer = "pancreatic cancer"
    gastric_cancer = "gastric cancer"
    oesophagus_junction_cancer = "oesophagus and esophagogastric junction cancer"
    unknown = "unknown cancer type"


class TreatmentEnum(str, Enum):
    surgery = "Surgery"
    chemotherapy = "Chemotherapy"
    radiotherapy = "Radiotherapy"
    immunotherapy = "Immunotherapy"


class TreatmentStatusEnum(str, Enum):
    curative = "Curative"
    palliative = "Palliative"
    adjuvant = "Adjuvant"
    neo_adjuvant = "Neo-adjuvant"


class TreatmentToleranceEnum(str, Enum):
    good = "Good"
    medium = "Medium"
    poor = "Poor"


class ChemotherapyData(BaseModel):
    chemotherapy_name: str = Field(
        description="Name of the chemotherapy drug or regimen (e.g., FOLFIRINOX)"
    )
    chemotherapy_start_date: Optional[date] = Field(
        default=None,
        description="Start date of this specific chemotherapy line",
    )
    chemotherapy_end_date: Optional[date] = Field(
        default=None,
        description="End date of this specific chemotherapy line",
    )
    chemotherapy_tolerance: TreatmentToleranceEnum = Field(
        description="Patient's tolerance to the treatment"
    )

    @field_validator("chemotherapy_start_date", "chemotherapy_end_date", mode="before")
    @classmethod
    def _parse_chemo_dates(cls, v: Any) -> Optional[date]:
        return _coerce_clinical_date(v)


# class CurativeSurgery(BaseModel):

#     surgery_date: date = Field(description="Date of the surgery")
#     surgeon_name: Optional[str] = Field(description="Name of the surgeon")
#     surgery_name: Optional[str] = Field(description="Name of the surgery")


class PreviousTreatmentData(BaseModel):
    treatment_date: PastDate = Field(description="Date of the treatment")
    treatment_name: TreatmentEnum = Field(description="Name of the treatment")
    treatment_status: TreatmentStatusEnum = Field(
        description="Status of the treatment regarding the disease (e.g., Curative, Palliative)"
    )


# class CurativeSurgery(BaseModel):

#     surgery_date: date = Field(description="Date of the surgery")
#     surgeon_name: Optional[str] = Field(description="Name of the surgeon")
#     surgery_name: Optional[str] = Field(description="Name of the surgery")


class PancreaticTumorEnum(str, Enum):
    adenocarcinoma = "adenocarcinoma"
    neuroendocrin = "neuroendocrine tumor"
    unknown = "unknown"


class PancreaticSymptomsEnum(str, Enum):
    pain = "pain"
    jaundice = "jaundice"
    mass = "mass"
    weight_loss = "weight loss"


class LiverSymptomsEnum(str, Enum):
    ascite = "ascite"
    jaundice = "jaundice"
    digestive_bleeding = "digestive bleeding"
    encephalopathy = "encephalopathy"


class ChildPugh(BaseModel):
    """
    Evaluation of the Child-Pugh score.

    Attributes:
        bilirubine: Bilirubin level in blood.
        albumine: Albumin level in blood.
        prothrombine: Prothrombin time.
        ascite: Presence of ascites.
        encephalopathie: Presence of encephalopathy.

    Examples:
        >>> child_pugh = ChildPugh(
                bilirubine=2,
                albumine=3,
                prothrombine=50,
                ascite=False,
                encephalopathie=False
            )
    """

    bilirubin: int = Field(description="Bilirubin level in blood (µmol/L or mg/dL)")
    albumine: int = Field(description="Albumin level in blood")
    prothrombine: int = Field(description="Prothrombin time")
    ascite: bool = Field(description="Presence of ascites")
    encephalopathie: bool = Field(description="Presence of encephalopathy")

    question: ClassVar[str] = "Tell me the Child-Pugh score."


class RadiologicalExamination(BaseModel):
    """
    This class contains all possible informations about one imagery exam
    """

    exam_name: str = Field(description="The name of the radiological exam")
    exam_date: Optional[date] = Field(
        default=None,
        description="The date when the radiological examination was performed (YYYY-MM-DD).",
    )
    exam_type: RadiologicExamType = Field(
        description="The type of radiological examination performed (e.g., CT, MRI, X-ray, EUS)."
    )
    exam_result: Optional[MarkdownStr] = Field(
        description="Summary of key findings from the radiological report",
        default="N/A",
    )

    @field_validator("exam_date", mode="before")
    @classmethod
    def _parse_exam_date(cls, v: Any) -> Optional[date]:
        return _coerce_clinical_date(v)


class HistologicAnalysis(BaseModel):
    """
    This class contains all informations related to a histological analysis.

    Attributes:
        date (datetime): Date when the biopsy or resection was performed.
        contributive (bool): Indicator of the importance of the results (conclusive or not).
        result (str): Complete result of the histological analysis.

    Examples:
        >>> analysis = HistologicAnalysis(
                date=datetime.date(2022, 1, 1),
                contributive=True,
                result="Result of a detailed histological analysis"
            )
    """

    histology_date: date = Field(description="Date of biopsy or resection")
    contributive: bool = Field(description="Importance of results (conclusive or not)")
    result: MarkdownStr = Field(
        description="Complete result of the histological analysis"
    )


class RadiologicalExaminations(BaseModel):
    """
    A container for a patient's radiology studies.

    Attributes:
        exams_all (list[RadiologicalExamination]): All of the patient's radiology studies.
        ct_scans (list[RadiologicalExamination]): The patient's computed tomography (CT) scans.
        mri_studies (list[RadiologicalExamination]): The patient's magnetic resonance imaging (MRI) studies.
        pet_scans (list[RadiologicalExamination]): The patient's positron emission tomography (PET) scans.

    Examples:
        >>> exams = RadiologicalExaminations(
                exams_all=[RadiologicalExamination(...)],
                ct_scans=[RadiologicalExamination(...)],
                mri_studies=[RadiologicalExamination(...)],
                pet_scans=[RadiologicalExamination(...)]
            )
    """

    exams_all: list[RadiologicalExamination] = Field(
        description="All of the patient's radiology studies"
    )
    ct_scans: list[RadiologicalExamination] = Field(
        description="The patient's computed tomography (CT) scans"
    )
    mri_studies: list[RadiologicalExamination] = Field(
        description="The patient's magnetic resonance imaging (MRI) studies"
    )
    pet_scans: list[RadiologicalExamination] = Field(
        description="The patient's positron emission tomography (PET) scans"
    )


class DiscussionPriority(IntEnum):
    """4-level MDT discussion priority scale plus NOT_ASSESSED (smaller int = higher priority)."""

    TIME_BOUND = 1
    DECISION_NEEDED = 2
    STANDARD_SIGN_OFF = 3
    INFORMATION = 4
    NOT_ASSESSED = 9

    @property
    def sort_rank(self) -> int:
        """Sort order within an attendance tier: P1 -> P2 -> NOT_ASSESSED -> P3 -> P4."""
        return {
            DiscussionPriority.TIME_BOUND: 1,
            DiscussionPriority.DECISION_NEEDED: 2,
            DiscussionPriority.NOT_ASSESSED: 3,
            DiscussionPriority.STANDARD_SIGN_OFF: 4,
            DiscussionPriority.INFORMATION: 5,
        }[self]

    @property
    def code(self) -> str:
        """Short machine/badge code (P1..P4 or NOT_ASSESSED)."""
        return {
            DiscussionPriority.TIME_BOUND: "P1",
            DiscussionPriority.DECISION_NEEDED: "P2",
            DiscussionPriority.STANDARD_SIGN_OFF: "P3",
            DiscussionPriority.INFORMATION: "P4",
            DiscussionPriority.NOT_ASSESSED: "NOT_ASSESSED",
        }[self]

    @property
    def label_fr(self) -> str:
        """Concise French label (<= 24 chars)."""
        return {
            DiscussionPriority.TIME_BOUND: "P1 · Échéance proche",
            DiscussionPriority.DECISION_NEEDED: "P2 · Décision à prendre",
            DiscussionPriority.STANDARD_SIGN_OFF: "P3 · Validation standard",
            DiscussionPriority.INFORMATION: "P4 · Information",
            DiscussionPriority.NOT_ASSESSED: "Non évaluée",
        }[self]

    @property
    def label_en(self) -> str:
        """Concise English label (<= 24 chars)."""
        return {
            DiscussionPriority.TIME_BOUND: "P1 · Time-bound",
            DiscussionPriority.DECISION_NEEDED: "P2 · Decision needed",
            DiscussionPriority.STANDARD_SIGN_OFF: "P3 · Standard sign-off",
            DiscussionPriority.INFORMATION: "P4 · Information",
            DiscussionPriority.NOT_ASSESSED: "Not assessed",
        }[self]

    @classmethod
    def from_any(cls, value: Any) -> Optional["DiscussionPriority"]:
        """Parse canonical int, code (P1..P4), or enum member name into DiscussionPriority."""
        if isinstance(value, cls):
            return value
        if isinstance(value, bool):
            return None
        if isinstance(value, int):
            try:
                return cls(value)
            except ValueError:
                return None
        if isinstance(value, str):
            raw = value.strip()
            if not raw:
                return None
            if raw.isdigit():
                try:
                    return cls(int(raw))
                except ValueError:
                    return None
            upper = raw.upper()
            code_map = {
                "P1": cls.TIME_BOUND,
                "TIME_BOUND": cls.TIME_BOUND,
                "P1 · TIME-BOUND": cls.TIME_BOUND,
                "P1 · ÉCHÉANCE PROCHE": cls.TIME_BOUND,
                "P2": cls.DECISION_NEEDED,
                "DECISION_NEEDED": cls.DECISION_NEEDED,
                "P2 · DECISION NEEDED": cls.DECISION_NEEDED,
                "P2 · DÉCISION À PRENDRE": cls.DECISION_NEEDED,
                "P3": cls.STANDARD_SIGN_OFF,
                "STANDARD_SIGN_OFF": cls.STANDARD_SIGN_OFF,
                "P3 · STANDARD SIGN-OFF": cls.STANDARD_SIGN_OFF,
                "P3 · VALIDATION STANDARD": cls.STANDARD_SIGN_OFF,
                "P4": cls.INFORMATION,
                "INFORMATION": cls.INFORMATION,
                "P4 · INFORMATION": cls.INFORMATION,
                "NOT_ASSESSED": cls.NOT_ASSESSED,
                "NON ÉVALUÉE": cls.NOT_ASSESSED,
                "NOT ASSESSED": cls.NOT_ASSESSED,
            }
            if upper in code_map:
                return code_map[upper]
            for prefix, member in (
                ("P1", cls.TIME_BOUND),
                ("P2", cls.DECISION_NEEDED),
                ("P3", cls.STANDARD_SIGN_OFF),
                ("P4", cls.INFORMATION),
            ):
                if upper.startswith(f"{prefix} ") or upper.startswith(f"{prefix}·"):
                    return member
        return None

    @classmethod
    def __get_pydantic_core_schema__(cls, source_type: Any, handler: Any) -> Any:
        from pydantic_core import core_schema

        def _coerce_priority(val: Any) -> Any:
            parsed = cls.from_any(val)
            return parsed.value if parsed is not None else val

        return core_schema.no_info_before_validator_function(
            _coerce_priority,
            handler(source_type),
        )


class PriorityAssessment(BaseModel):
    """Immutable value object capturing MDT discussion priority, rationale, and provenance."""

    model_config = ConfigDict(frozen=True)

    level: DiscussionPriority
    reason: str = ""
    source: Literal["rule", "ai", "manual"] = "rule"


def _as_section_dict(val: Any) -> dict[str, Any]:
    if isinstance(val, BaseModel):
        return val.model_dump(mode="json")
    return val if isinstance(val, dict) else {}


def suggest_priority(sections: dict[str, Any] | None) -> PriorityAssessment:
    """Deterministically suggest a baseline DiscussionPriority from extracted clinical sections."""
    if not isinstance(sections, dict) or not sections:
        return PriorityAssessment(
            level=DiscussionPriority.NOT_ASSESSED,
            reason="Dossier incomplet pour qualifier la priorité de passage",
            source="rule",
        )

    planned_surg = _as_section_dict(sections.get("PlannedCurativeSurgery"))
    if planned_surg.get("planned_curative_surgery") is True:
        return PriorityAssessment(
            level=DiscussionPriority.TIME_BOUND,
            reason="Chirurgie curative programmée en attente de validation RCP",
            source="rule",
        )

    cancer_desc = _as_section_dict(sections.get("CancerDescription"))
    recist = str(cancer_desc.get("recist_response") or "").strip().lower()
    if any(tok in recist for tok in ("pd", "progress", "évolut", "evolut")):
        return PriorityAssessment(
            level=DiscussionPriority.TIME_BOUND,
            reason="Progression tumorale sous traitement actif (RECIST PD)",
            source="rule",
        )

    hepatic = _as_section_dict(sections.get("HepaticStatus"))
    bili_raw = hepatic.get("bilirubin_umol_l")
    try:
        if bili_raw is not None and float(bili_raw) >= 50.0:
            return PriorityAssessment(
                level=DiscussionPriority.TIME_BOUND,
                reason="Hyperbilirubinémie marquée nécessitant une évaluation rapide pré-RCP",
                source="rule",
            )
    except (TypeError, ValueError):
        pass

    chemo = _as_section_dict(sections.get("ChemotherapyTreament"))
    prev_surg = _as_section_dict(sections.get("PreviousCurativeSurgery"))
    tumor_loc = _as_section_dict(sections.get("TumorLocation"))
    organ = str(tumor_loc.get("tumor_location") or "").strip().lower()
    has_onco_core = bool(organ and organ != "unknown") or bool(
        cancer_desc.get("type_of_cancer")
    )
    has_sma_core = bool(
        sections.get("MotorFunctionStatus")
        or sections.get("RespiratoryFunction")
        or sections.get("BulbarAndNutritionalStatus")
        or sections.get("GeneticDiagnosis")
    )

    if has_onco_core or has_sma_core:
        if prev_surg.get("previous_curative_surgery") is True and not chemo.get(
            "chemotherapy"
        ):
            return PriorityAssessment(
                level=DiscussionPriority.STANDARD_SIGN_OFF,
                reason="Validation standard post-opératoire conforme aux référentiels",
                source="rule",
            )
        return PriorityAssessment(
            level=DiscussionPriority.DECISION_NEEDED,
            reason="Décision diagnostique ou thérapeutique à statuer en RCP",
            source="rule",
        )

    return PriorityAssessment(
        level=DiscussionPriority.NOT_ASSESSED,
        reason="Éléments cliniques insuffisants pour qualifier la priorité de passage",
        source="rule",
    )


def merge_priority(
    rule: PriorityAssessment,
    ai: PriorityAssessment | None,
    manual: PriorityAssessment | None,
) -> PriorityAssessment:
    """Merge deterministic rule, AI consensus, and manual override (manual wins; AI never downgrades rule)."""
    if manual is not None:
        return PriorityAssessment(
            level=manual.level,
            reason=manual.reason,
            source="manual",
        )
    if ai is not None and ai.level != DiscussionPriority.NOT_ASSESSED:
        if rule.level == DiscussionPriority.NOT_ASSESSED or int(ai.level) <= int(
            rule.level
        ):
            return PriorityAssessment(
                level=ai.level,
                reason=ai.reason or rule.reason,
                source="ai",
            )
    return rule


class Reference(BaseModel):
    name: str = Field(description="Name of the reference")
    page: int = Field(description="Page of the document")
    position: str = Field(description="Position of the reference")
    excerpt: MarkdownStr = Field(
        description="Summarize relevant excerpt from the document, no more than 3 lines"
    )


class ExpertSuggestion(BaseModel):
    suggestion: MarkdownStr = Field(
        description="Pre-MDT orientation options grounded in guidelines"
    )

    why: MarkdownStr = Field(
        description="Explanation of the reasoning behind the suggestion"
    )

    references: list[Reference] = Field(
        description="list of clinical guideline references supporting the suggestion"
    )


class MTDComplete(BaseModel):
    is_mtd_complete: Union[bool, Literal["partial"]] = Field(
        default=True,
        description=(
            "Based on your specialty and provided documents, is the MDT file complete? "
            "(True if complete, 'partial' if partially complete, False if incomplete)"
        ),
    )

    @field_validator("is_mtd_complete", mode="before")
    @classmethod
    def _normalize_is_mtd_complete(cls, v: Any) -> bool | Literal["partial"]:
        if isinstance(v, bool):
            return v
        if isinstance(v, str):
            norm = v.strip().lower()
            if norm in ("partial", "partiel", "partially", "partiellement"):
                return "partial"
            if norm in ("true", "yes", "oui", "1", "complet", "complete"):
                return True
            if norm in ("false", "no", "non", "0", "incomplet", "incomplete"):
                return False
        return bool(v)

    reflection: Optional[MarkdownStr] = Field(
        default=None,
        description="Detailed reflection, reasoning, or synthesis of the collaborative team discussion",
    )

    what_missing: list[str] = Field(
        default=[], description="List of missing elements required for a decision"
    )

    references: list[Reference] = Field(
        description="list of clinical guideline references for the missing items"
    )
