from __future__ import annotations

from typing import TYPE_CHECKING, Any, ClassVar, Optional

from pydantic import Field, field_validator

from src.domain.common.common_ressources import *  # noqa: F403
from src.domain.common.common_ressources import MarkdownStr
from src.domain.common.patient_mdt_common_form import PatientMDTForm
from src.domain.sma.agents import Agents

if TYPE_CHECKING:
    from src.application.agent.agent import MedSyntisAgent


class PatientMDTSmaForm(PatientMDTForm):
    """
    This class contains all patient and SMA disease information for the report.
    """

    class PatientPerformanceStatus(PatientMDTForm.default_model):
        """
        Patient WHO performance status
        """

        performance_status: Optional[WHOPerformanceStatus] = Field(  # noqa: F405
            default=None,
            description="WHO/OMS performance status of the patient, score from 0 to 4",
        )

        question: ClassVar[str] = (
            "Determine the WHO performance status of the patient (0-4). Look for 'OMS', 'WHO', or 'Performance Status' in the document. If not found, set it to null."
        )

    class GeneticDiagnosis(PatientMDTForm.default_model):
        """
        Genetic characteristics of Spinal Muscular Atrophy (SMN1 mutation and SMN2 copy number)
        """

        smn1_deletion_confirmed: Optional[bool] = Field(
            default=None,
            description="Is the homozygous deletion or mutation of SMN1 confirmed?",
        )
        smn2_copy_count: Optional[int] = Field(
            default=None,
            ge=0,
            le=10,
            description="Number of SMN2 backup gene copies (crucial for prognosis and treatment eligibility)",
        )
        other_genetic_variants: Optional[MarkdownStr] = Field(
            default=None,
            description="Other genetic modifiers or variations found, if any",
        )

        question: ClassVar[str] = (
            "Extract molecular genetic testing results. Confirm if the SMN1 homozygous deletion is present and find the exact number of SMN2 copies (typically 1 to 5 copies)."
        )

    class MotorFunctionStatus(PatientMDTForm.default_model):
        """
        SMA clinical classification and standardized motor scale scores
        """

        sma_type: str = Field(
            description="Clinical type of SMA: Type 1 (Werdnig-Hoffmann), Type 2, Type 3 (Kugelberg-Welander), or Type 4",
            json_schema_extra={
                "options": [
                    "Type 1",
                    "Type 2",
                    "Type 3",
                    "Type 4",
                    "Pré-symptomatique",
                ]
            },
        )
        motor_milestones: list[MarkdownStr] = Field(
            description="Achieved motor milestones (e.g. head control, sitting unsupported, standing, independent walking)"
        )
        mfm_scale_version: Optional[str] = Field(
            default=None,
            description="Motor Function Measure (MFM) scale version used: MFM-32 (≥ 6 years, /96) or MFM-20 (2 to < 6 years, /60)",
        )
        mfm_total_score: Optional[int | float | str] = Field(
            default=None,
            description="Motor Function Measure (MFM) total score in % of maximum possible score (0-100%, ratio, or clinical note)",
        )
        mfm_d1_score: Optional[int | float | str] = Field(
            default=None,
            description="MFM D1 subscore (Standing and transfers) in % of maximum possible score (0-100%, ratio, or clinical note)",
        )
        mfm_d2_score: Optional[int | float | str] = Field(
            default=None,
            description="MFM D2 subscore (Axial and proximal motor function) in % of maximum possible score (0-100%, ratio, or clinical note)",
        )
        mfm_d3_score: Optional[int | float | str] = Field(
            default=None,
            description="MFM D3 subscore (Distal motor function) in % of maximum possible score (0-100%, ratio, or clinical note)",
        )
        rulm_score: Optional[int | float | str] = Field(
            default=None,
            description="Revised Upper Limb Module (RULM) raw score (0-37, ratio, bilateral D/G, or clinical note)",
        )
        chop_intend_score: Optional[int | float | str] = Field(
            default=None,
            description="CHOP INTEND raw score (usually for Type 1 infants, 0-64, ratio, or clinical note)",
        )
        hfmse_score: Optional[int | float | str] = Field(
            default=None,
            description="Hammersmith Functional Motor Scale Expanded (HFMSE) raw score (0-66, ratio, bilateral, or clinical note)",
        )

        @staticmethod
        def _check_motor_bounds(
            num: float, min_val: float, max_val: float, label: str
        ) -> None:
            """Raise ValueError if a numeric motor scale value is outside [min_val, max_val]."""
            if num < min_val or num > max_val:
                raise ValueError(
                    f"{label} score must be between {min_val:g} and {max_val:g}."
                )

        @classmethod
        def _parse_motor_scale_string(
            cls, raw_str: str, min_val: float, max_val: float, label: str
        ) -> int | float | str | None:
            """Parse a string motor scale value (ratio, percentage, number, or clinical note)."""
            cleaned = raw_str.strip()
            if not cleaned:
                return None
            first_token = cleaned.split()[0]
            if "/" in first_token:
                return first_token
            candidate = (
                first_token[:-1].replace(",", ".")
                if first_token.endswith("%")
                else cleaned
            )
            try:
                num = float(candidate)
            except ValueError:
                return cleaned
            cls._check_motor_bounds(num, min_val, max_val, label)
            has_decimal = "." in candidate or "," in first_token
            return int(num) if num.is_integer() and not has_decimal else num

        @classmethod
        def _validate_raw_motor_scale(
            cls, value: Any, min_val: float, max_val: float, label: str
        ) -> int | float | str | None:
            """Validate a motor scale value while stripping verbose LLM commentary and preserving raw scores."""
            if value is None:
                return None
            if isinstance(value, bool):
                raise ValueError(f"{label} cannot be a boolean.")
            if isinstance(value, (int, float)):
                cls._check_motor_bounds(float(value), min_val, max_val, label)
                return value
            if isinstance(value, str):
                return cls._parse_motor_scale_string(value, min_val, max_val, label)
            raise ValueError(f"Unsupported type for {label}.")

        @field_validator(
            "mfm_total_score",
            "mfm_d1_score",
            "mfm_d2_score",
            "mfm_d3_score",
            mode="before",
        )
        @classmethod
        def validate_mfm_scores(cls, v: Any) -> int | float | str | None:
            return cls._validate_raw_motor_scale(v, 0, 100, "MFM")

        @field_validator("rulm_score", mode="before")
        @classmethod
        def validate_rulm_score(cls, v: Any) -> int | float | str | None:
            return cls._validate_raw_motor_scale(v, 0, 37, "RULM")

        @field_validator("chop_intend_score", mode="before")
        @classmethod
        def validate_chop_intend_score(cls, v: Any) -> int | float | str | None:
            return cls._validate_raw_motor_scale(v, 0, 64, "CHOP INTEND")

        @field_validator("hfmse_score", mode="before")
        @classmethod
        def validate_hfmse_score(cls, v: Any) -> int | float | str | None:
            return cls._validate_raw_motor_scale(v, 0, 66, "HFMSE")

        question: ClassVar[str] = (
            "Determine the SMA clinical type (1, 2, 3, or 4), list the patient's current motor milestones, "
            "and extract standardized motor scale scores found in the clinical records, prioritizing the French reference "
            "MFM (Mesure de la Fonction Motrice: scale version MFM-32 or MFM-20, total score in %, and D1 standing/transfers, "
            "D2 axial/proximal, D3 distal subscores in %), as well as RULM and CHOP INTEND (or HFMSE if explicitly documented). "
            "IMPORTANT: For mfm_total_score, mfm_d1_score, mfm_d2_score, mfm_d3_score, rulm_score, chop_intend_score, and hfmse_score, "
            "output ONLY the raw score value itself (e.g. 64.6, '64.6%', '18/37', '9/66', or '28 (D) / 30 (G)'). "
            "Do NOT include dates, deltas, comparisons to baseline, or progression history."
        )

    class RespiratoryFunction(PatientMDTForm.default_model):
        """
        Respiratory status and mechanical ventilation requirements
        """

        requires_ventilation_support: Optional[bool] = Field(
            default=None,
            description="Does the patient require respiratory assistance?",
        )
        ventilation_type: Optional[str] = Field(
            default=None,
            description="Type of support: Non-invasive ventilation (NIV/BiPAP), Tracheostomy, or None",
            json_schema_extra={
                "options": [
                    "None",
                    "Non-invasive ventilation (NIV/BiPAP)",
                    "Tracheostomy",
                ]
            },
        )
        daily_ventilation_hours: Optional[float] = Field(
            default=None,
            ge=0,
            le=24,
            description="Number of hours of ventilation per day",
        )
        uses_cough_assist: Optional[bool] = Field(
            default=None,
            description="Does the patient use a mechanical insufflator-exsufflator (cough assist)?",
        )
        forced_vital_capacity_percent: Optional[float] = Field(
            default=None,
            ge=0,
            le=150,
            description="Forced Vital Capacity (FVC / CVF) in % of predicted value",
        )

        question: ClassVar[str] = (
            "Extract respiratory evaluations: check if the patient uses ventilation support (NIV, tracheostomy) or a cough assist machine, and look for pulmonary function test values like FVC (CVF) percentage. Set undocumented fields to null."
        )

    class OrthopedicAndSpineStatus(PatientMDTForm.default_model):
        """
        Spine deformities and joint contractures assessment
        """

        has_scoliosis: Optional[bool] = Field(
            default=None,
            description="Presence of scoliosis",
        )
        scoliosis_cobb_angle: Optional[float] = Field(
            default=None,
            ge=0,
            le=180,
            description="Scoliosis Cobb angle in degrees if measured",
        )
        spine_surgery_history: Optional[bool] = Field(
            default=None,
            description="Has the patient undergone spinal fusion / arthrodesis?",
        )
        joint_contractures: list[MarkdownStr] = Field(
            default_factory=list,
            description="Affected joints with contractures (e.g. hips, knees, ankles)",
        )
        wheelchair_user: Optional[bool] = Field(
            default=None,
            description="Does the patient require a wheelchair (manual or electric)?",
        )

        question: ClassVar[str] = (
            "Search for spine and orthopedic assessments. Check for scoliosis presence, the Cobb angle, history of spinal surgery, joints affected by contractures, and whether the patient is wheelchair-dependent. Set undocumented fields to null."
        )

    class BulbarAndNutritionalStatus(PatientMDTForm.default_model):
        """
        Swallowing abilities, feeding methods, and growth/weight monitoring
        """

        has_dysphagia: Optional[bool] = Field(
            default=None,
            description="Does the patient have swallowing difficulties?",
        )
        feeding_mode: Optional[str] = Field(
            default=None,
            description="Primary feeding mode: Oral, Oral with thickening, Gastrostomy tube (G-tube / GPE), or Nasogastric tube",
            json_schema_extra={
                "options": [
                    "Oral",
                    "Oral with thickening",
                    "Gastrostomy tube (G-tube / GPE)",
                    "Nasogastric tube",
                ]
            },
        )
        history_aspiration_pneumonia: Optional[bool] = Field(
            default=None,
            description="History of aspiration pneumonia (fausses routes)",
        )
        nutritional_status: Optional[str] = Field(
            default=None,
            description="Nutritional status: Normal, Failure to thrive / Underweight, Overweight",
            json_schema_extra={
                "options": [
                    "Normal",
                    "Failure to thrive / Underweight",
                    "Overweight",
                ]
            },
        )

        question: ClassVar[str] = (
            "Extract information regarding bulbar function: presence of dysphagia, history of aspiration pneumonia, current feeding method (oral or tube feeding), and overall nutritional/weight monitoring. Set undocumented fields to null."
        )

    class RadiologicExams(PatientMDTForm.default_model):
        """
        List of radiological exams
        """

        exams_list: list[RadiologicalExamination] = Field(  # noqa: F405
            description="List of radiological exams"
        )

        question: ClassVar[str] = (
            "List all radiological exams found in the documents. Include date, name, type, and a summary of results for each."
        )

    class ExpertAnswer(PatientMDTForm.ExpertAnswer):
        agents: ClassVar[list[type[MedSyntisAgent]]] = [
            Agents.Neurologist_expert_agent,
            Agents.Geneticist_expert_agent,
            Agents.Pulmonologist_expert_agent,
            Agents.Physiotherapy_expert_agent,
            Agents.Orthopedist_expert_agent,
        ]

    class MTDCompleted(PatientMDTForm.MTDCompleted):
        agents: ClassVar[list[type[MedSyntisAgent]]] = Agents().expert_agents

    class CareOrientationProposal(PatientMDTForm.CareOrientationProposal):
        """
        Pre-MDT collaborative synthesis proposing whether an initiation or adaptation
        of patient care should be discussed by the medical board, its priority, and rationale.
        """

        agents: ClassVar[list[type[MedSyntisAgent]]] = Agents().expert_agents
        collaborative = True

        question: ClassVar[str] = """
            Based on the multidisciplinary SMA expert debate (neurologist, geneticist, pulmonologist, orthopedist, physiotherapist), synthesize a pre-MDT orientation proposal to assist the medical board (do not replace the physicians' final decision):
            Determine if an initiation or adaptation of therapeutic, respiratory, nutritional, orthopedic, or rehabilitative care should be discussed for this SMA patient.
            If yes, specify:
            1. The suggested priority level (`suggested_priority`) for the MDT discussion.
               CRITICAL SAFETY RULE: In Spinal Muscular Atrophy, motor neuron loss is irreversible ("Time is Motoneuron") and respiratory/bulbar decompensations are life-threatening. Ignore the priority of any expert whose expertise is not relevant to the case (`expert_relevant=False`). If even a single relevant expert (`expert_relevant=True`) in the debate flags the case as urgent or high priority (e.g., infant SMA Type 1 or pre-symptomatic newborn needing immediate disease-modifying therapy, rapid motor regression on MFM/RULM/CHOP-INTEND, respiratory insufficiency requiring NIV/Cough Assist, dysphagia with aspiration pneumonia risk, or rapidly progressing scoliosis compromising lung function), you MUST default to classifying `suggested_priority` as urgent (high priority), regardless of whether other experts recommend a lower priority.
            2. What kind of care modality (`proposed_care_type`) should be discussed (e.g., SMN-targeted disease-modifying therapy initiation/switch [nusinersen, risdiplam, onasemnogene abeparvovec], NIV/BiPAP or Cough Assist adaptation, nutritional/gastrostomy support, orthopedic spine management/arthrodesis, or specialized rehabilitation).
            Provide a clear `clinical_rationale` detailing the positions of the experts and French PNDS SMA guidelines, especially highlighting any divergence in opinions regarding urgency.
            """

    @classmethod
    def should_run_care_orientation_debate(
        cls,
        doc_or_form: "dict[str, Any] | PatientMDTForm | None",
    ) -> bool:
        """Trigger Debate Path when SMA bulbar or respiratory adaptation complexity is present."""
        d = cls._as_dict(doc_or_form) if doc_or_form is not None else {}
        sma_resp = d.get("RespiratoryAssessment")
        if isinstance(sma_resp, dict) and (
            sma_resp.get("has_bulbar_symptoms")
            or sma_resp.get("needs_ventilation_adaptation")
        ):
            return True
        return False
