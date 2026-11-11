from datetime import datetime
from enum import Enum
import uuid

from pydantic import BaseModel, Field


class RCPProcessingStatus(str, Enum):
    """Processing status of a `PatientMDTForm` record in persistence."""

    PENDING_ADMIN = "PENDING_ADMIN"
    PROCESSING_ADMIN = "PROCESSING_ADMIN"
    PENDING_CLINICAL = "PENDING_CLINICAL"
    PROCESSING_CLINICAL = "PROCESSING_CLINICAL"
    PENDING_EXPERTS = "PENDING_EXPERTS"
    PROCESSING_EXPERTS = "PROCESSING_EXPERTS"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"

    @classmethod
    def labels_fr(cls) -> dict[str, str]:
        return {
            cls.PENDING_ADMIN.value: "⏳ En attente de traitement",
            cls.PROCESSING_ADMIN.value: "🔍 Identification du patient en cours",
            cls.PENDING_CLINICAL.value: "⏳ Extraction clinique en attente",
            cls.PROCESSING_CLINICAL.value: "🔄 Extraction clinique en cours",
            cls.PENDING_EXPERTS.value: "⏳ Concertation d'experts en attente",
            cls.PROCESSING_EXPERTS.value: "🩺 Concertation d'experts en cours",
            cls.COMPLETED.value: "✅ Dossier prêt",
            cls.FAILED.value: "❌ Échec du traitement",
        }


PatientMDTFormProcessingStatus = RCPProcessingStatus


class JobStatus(str, Enum):
    """Execution status of a task in the priority processing queue."""

    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"

    @classmethod
    def labels_fr(cls) -> dict[str, str]:
        return {
            cls.PENDING.value: "⏳ En attente",
            cls.PROCESSING.value: "🔄 En cours",
            cls.COMPLETED.value: "✅ Terminé",
            cls.FAILED.value: "❌ Échec",
            cls.CANCELLED.value: "🚫 Annulé",
        }


class JobType(str, Enum):
    """Task type in the priority processing queue."""

    WAVE1_ADMIN = "WAVE1_ADMIN"
    WAVE2_CLINICAL = "WAVE2_CLINICAL"
    WAVE3_EXPERTS = "WAVE3_EXPERTS"
    SINGLE_MODEL = "SINGLE_MODEL"
    PATIENT_SUMMARY = "PATIENT_SUMMARY"

    @classmethod
    def labels_fr(cls) -> dict[str, str]:
        return {
            cls.WAVE1_ADMIN.value: "Identification du patient",
            cls.WAVE2_CLINICAL.value: "Extraction du dossier clinique",
            cls.WAVE3_EXPERTS.value: "Concertation d'experts & décision RCP",
            cls.SINGLE_MODEL.value: "Mise à jour d'une rubrique",
            cls.PATIENT_SUMMARY.value: "Résumé global du dossier patient",
        }


class JobPriority:
    """Standard scheduling priorities (higher value = higher priority)."""

    WAVE1_ADMIN = 100
    WAVE1_ADMIN_IMPORT = 100
    WAVE1_ADMIN_RERUN = 95
    SINGLE_MODEL_RERUN = 90
    PATIENT_SUMMARY = 85
    FULL_RCP_RERUN = 80
    WAVE2_CLINICAL_RERUN = 80
    WAVE3_EXPERTS_RERUN = 75
    WAVE2_CLINICAL = 70
    WAVE2_CLINICAL_IMPORT = 70
    WAVE3_EXPERTS = 40
    WAVE3_EXPERTS_IMPORT = 40


class QueueJob(BaseModel):
    """Domain model representing a task in the priority processing queue."""

    job_id: str = Field(
        default_factory=lambda: f"job_{uuid.uuid4().hex[:12]}",
        description="Unique identifier of the queue task",
    )
    batch_id: str | None = Field(
        default=None,
        description="Upload batch identifier grouping files imported together",
    )
    domain: str = Field(
        default="oncology",
        description="Clinical application domain (oncology, sma)",
    )
    filename: str = Field(
        description="PDF filename of the PatientMDTForm document",
    )
    target_patient_id: str | None = Field(
        default=None,
        description="Explicit patient identifier enforced at import time (None if automatic)",
    )
    resolved_patient_id: str | None = Field(
        default=None,
        description="Resolved patient identifier after administrative identification",
    )
    patient_label: str | None = Field(
        default=None,
        description="Formatted patient display label once identified",
    )
    job_type: JobType = Field(
        default=JobType.WAVE1_ADMIN,
        description="Queue task type (WAVE1_ADMIN, WAVE2_CLINICAL, WAVE3_EXPERTS, SINGLE_MODEL, PATIENT_SUMMARY)",
    )
    model_name: str | None = Field(
        default=None,
        description="Target section model name when job_type == SINGLE_MODEL",
    )
    status: JobStatus = Field(
        default=JobStatus.PENDING,
        description="Current execution status of the task",
    )
    priority: int = Field(
        default=JobPriority.WAVE1_ADMIN_IMPORT,
        description="Scheduling priority (higher value = higher priority)",
    )
    depends_on_job_id: str | None = Field(
        default=None,
        description="Parent task identifier (e.g. WAVE1_ADMIN) that must complete before execution",
    )
    worker_id: str | None = Field(
        default=None,
        description="Identifier of the worker executing the task",
    )
    lease_id: str | None = Field(
        default=None,
        description="Associated hardware execution lease identifier",
    )
    current_step: str = Field(
        default="En attente de traitement",
        description="Human-readable label of the current execution step",
    )
    completed_models: list[str] = Field(
        default_factory=list,
        description="List of clinical section models already extracted",
    )
    force_replace: bool = Field(
        default=False,
        description="Force recomputation even if the section already exists in persistence",
    )
    preserve_manual_edits: bool = Field(
        default=True,
        description="Preserve manually edited sections during a full rerun",
    )
    total_models: int = Field(
        default=1,
        ge=1,
        description="Total number of clinical section models to process in this task",
    )
    progress_pct: float = Field(
        default=0.0,
        ge=0.0,
        le=100.0,
        description="Completion percentage (0 to 100)",
    )
    attempts: int = Field(
        default=0,
        ge=0,
        description="Number of execution attempts performed",
    )
    max_retries: int = Field(
        default=2,
        ge=0,
        description="Maximum number of retry attempts allowed",
    )
    error_message: str | None = Field(
        default=None,
        description="Error message recorded on failure",
    )
    created_at: datetime = Field(
        default_factory=datetime.now,
        description="Task creation timestamp",
    )
    started_at: datetime | None = Field(
        default=None,
        description="Task execution start timestamp",
    )
    completed_at: datetime | None = Field(
        default=None,
        description="Task completion timestamp",
    )
    heartbeat_at: datetime | None = Field(
        default=None,
        description="Latest worker heartbeat timestamp",
    )
    active_agent: str | None = Field(
        default=None,
        description="Active AI agent currently generating reasoning tokens",
    )
    current_thinking: str = Field(
        default="",
        description="Live AI reasoning buffer captured during task execution",
    )
    thinking_updated_at: datetime | None = Field(
        default=None,
        description="Timestamp of the most recent AI reasoning token",
    )


class GpuLease(BaseModel):
    """Domain model representing an active hardware execution lease."""

    lease_id: str = Field(
        default_factory=lambda: f"lease_{uuid.uuid4().hex[:10]}",
        description="Unique hardware lease identifier",
    )
    worker_id: str = Field(description="Identifier of the worker holding the lease")
    domain: str = Field(description="Clinical application domain (oncology, sma)")
    job_id: str = Field(description="Identifier of the active queue task")
    filename: str = Field(description="PatientMDTForm PDF filename being processed")
    job_type: str = Field(default=JobType.WAVE1_ADMIN.value)
    acquired_at: datetime = Field(default_factory=datetime.now)
    heartbeat_at: datetime = Field(default_factory=datetime.now)
