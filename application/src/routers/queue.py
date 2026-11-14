import asyncio
from collections.abc import AsyncIterable
from typing import Annotated, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, status
from fastapi.sse import EventSourceResponse, ServerSentEvent

from src.application.paths import is_safe_filename
from src.infrastructure.queue import InMemoryQueueManager, get_global_queue_manager
from src.models.queue import (
    EnqueueImportRequest,
    EnqueueRerunRequest,
    EnqueueResponse,
    GpuLeaseResponse,
    JobDeletedResponse,
    QueueCleanRequest,
    QueueCleanResponse,
    QueueDomainsResponse,
    QueueJobResponse,
    QueueStatsResponse,
    QueueThinkingResponse,
    QueueThinkingStreamEvent,
    ReleaseLocksResponse,
)
from src.routers.dependencies import (
    DomainConfigDep,
    get_base_config,
    get_current_user_info,
    require_admin,
)

router = APIRouter(prefix="/queue", tags=["queue"])


class UnbufferedEventSourceResponse(EventSourceResponse):
    """SSE response enforcing `X-Accel-Buffering: no` and `Cache-Control: no-cache`."""

    def init_headers(self, headers=None) -> None:
        merged = dict(headers or {})
        merged.setdefault("X-Accel-Buffering", "no")
        merged.setdefault("Cache-Control", "no-cache")
        super().init_headers(merged)


def get_queue_manager() -> InMemoryQueueManager:
    return get_global_queue_manager()


QueueManagerDep = Annotated[InMemoryQueueManager, Depends(get_queue_manager)]


def _resolve_queue_domain_filter(
    request: Request,
    domain: str | None,
    all_domains: bool,
    user_info: dict[str, str | bool | None],
) -> str | None:
    """Resolve effective queue domain filter, restricting cross-domain visibility to admins or dev mode."""
    base_conf = get_base_config()
    if all_domains and (base_conf.dev_mode or bool(user_info.get("is_admin"))):
        return None
    requested = getattr(request.state, "requested_domain", None)
    if requested:
        return str(requested)
    if domain:
        return domain.strip().lower()
    resolved = getattr(request.state, "domain", None)
    if resolved:
        return str(resolved)
    return (base_conf.domain or "oncology").strip().lower()


def _require_existing_job(
    job_id: str,
    manager: QueueManagerDep,
) -> str:
    """Validate that `job_id` exists in the queue before starting an SSE stream."""
    if not manager.get_job(job_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tâche '{job_id}' introuvable.",
        )
    return job_id


async def _stream_thinking_sse(
    request: Request,
    manager: InMemoryQueueManager,
    *,
    job_id: str | None = None,
    domain: str | None = None,
    timeout: float = 30.0,
) -> AsyncIterable[ServerSentEvent]:
    """Non-blocking async SSE generator polling `manager` via `asyncio.to_thread` and checking disconnects."""
    if isinstance(manager, InMemoryQueueManager) and hasattr(
        manager, "poll_thinking_step"
    ):
        state: dict[str, object] = {
            "job_id": job_id,
            "domain": domain,
            "timeout": timeout,
        }
        while True:
            if await request.is_disconnected():
                break
            ev = await asyncio.to_thread(
                manager.poll_thinking_step,
                state,
                1.0,
                15.0,
            )
            if ev is None:
                continue
            payload = QueueThinkingStreamEvent.model_validate(ev)
            yield ServerSentEvent(data=payload, event=payload.event)
            if payload.event == "done":
                break
        return

    iterator = iter(
        manager.stream_job_thinking(job_id=job_id, domain=domain, timeout=timeout)
    )
    while True:
        if await request.is_disconnected():
            break
        ev = await asyncio.to_thread(next, iterator, None)
        if ev is None:
            break
        payload = QueueThinkingStreamEvent.model_validate(ev)
        yield ServerSentEvent(data=payload, event=payload.event)
        if payload.event == "done":
            break


@router.get("/domains", response_model=QueueDomainsResponse)
def get_allowed_domains():
    """Return active medical domains configured on the cross-domain API."""
    base_conf = get_base_config()
    return {
        "default_domain": base_conf.domain,
        "allowed_domains": base_conf.enabled_domains_list,
    }


@router.get("/stats", response_model=QueueStatsResponse)
def get_queue_stats_endpoint(
    request: Request,
    manager: QueueManagerDep,
    user_info: Annotated[dict[str, str | bool | None], Depends(get_current_user_info)],
    domain: Annotated[
        Optional[str],
        Query(description="Filter queue statistics by medical domain"),
    ] = None,
    all_domains: Annotated[
        bool,
        Query(description="Aggregate across all domains (admin or dev mode only)"),
    ] = False,
):
    """Retrieve statistics for the `PriorityQueue` and active execution slots."""
    target_domain = _resolve_queue_domain_filter(
        request=request,
        domain=domain,
        all_domains=all_domains,
        user_info=user_info,
    )
    return manager.get_queue_stats(domain=target_domain)


@router.get("/jobs", response_model=list[QueueJobResponse])
def get_queue_jobs_endpoint(
    request: Request,
    manager: QueueManagerDep,
    user_info: Annotated[dict[str, str | bool | None], Depends(get_current_user_info)],
    domain: Annotated[Optional[str], Query()] = None,
    all_domains: Annotated[
        bool,
        Query(description="List tasks across all domains (admin or dev mode only)"),
    ] = False,
    status_filter: Annotated[Optional[str], Query(alias="status")] = None,
    batch_id: Annotated[Optional[str], Query()] = None,
    filename: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
):
    """List tasks in the processing queue (filterable by domain, status, batch, or filename)."""
    target_domain = _resolve_queue_domain_filter(
        request=request,
        domain=domain,
        all_domains=all_domains,
        user_info=user_info,
    )
    return manager.get_queue_jobs(
        status=status_filter,
        batch_id=batch_id,
        limit=limit,
        domain=target_domain,
        filename=filename,
        offset=offset,
    )


@router.get("/jobs/{job_id}", response_model=QueueJobResponse)
def get_queue_job_endpoint(
    job_id: str,
    manager: QueueManagerDep,
):
    """Retrieve details of a specific queue job."""
    job = manager.get_job(job_id)
    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tâche '{job_id}' introuvable.",
        )
    return job


@router.get("/thinking", response_model=QueueThinkingResponse)
def get_active_thinking_endpoint(
    request: Request,
    manager: QueueManagerDep,
    domain: Annotated[Optional[str], Query()] = None,
    job_id: Annotated[Optional[str], Query()] = None,
):
    """Return a snapshot of the live AI reasoning for the currently running task or a specific `job_id`."""
    if job_id:
        snap = manager.get_job_thinking(job_id=job_id)
        if not snap.get("job_id"):
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Tâche '{job_id}' introuvable.",
            )
        return snap
    target_domain = getattr(request.state, "requested_domain", domain)
    return manager.get_job_thinking(job_id=None, domain=target_domain)


@router.get("/thinking/stream", response_class=UnbufferedEventSourceResponse)
async def stream_active_thinking_endpoint(
    request: Request,
    manager: QueueManagerDep,
    domain: Annotated[Optional[str], Query()] = None,
    job_id: Annotated[Optional[str], Query()] = None,
    timeout: Annotated[float, Query(ge=1.0, le=300.0)] = 30.0,
) -> AsyncIterable[ServerSentEvent]:
    """Stream live AI reasoning tokens (SSE) for the currently running task or a specific `job_id`."""
    target_domain = (
        None
        if job_id
        else (
            getattr(request.state, "requested_domain", None)
            or domain
            or getattr(request.state, "domain", None)
        )
    )
    async for event in _stream_thinking_sse(
        request=request,
        manager=manager,
        job_id=job_id,
        domain=target_domain,
        timeout=timeout,
    ):
        yield event


@router.get("/jobs/{job_id}/thinking", response_model=QueueThinkingResponse)
def get_job_thinking_endpoint(
    job_id: str,
    manager: QueueManagerDep,
):
    """Return a snapshot of the live AI reasoning for a specific task `job_id`."""
    snap = manager.get_job_thinking(job_id=job_id)
    if not snap.get("job_id"):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tâche '{job_id}' introuvable.",
        )
    return snap


@router.get(
    "/jobs/{job_id}/thinking/stream",
    response_class=UnbufferedEventSourceResponse,
)
async def stream_job_thinking_endpoint(
    request: Request,
    job_id: Annotated[str, Depends(_require_existing_job)],
    manager: QueueManagerDep,
    timeout: Annotated[float, Query(ge=1.0, le=300.0)] = 30.0,
) -> AsyncIterable[ServerSentEvent]:
    """Stream live AI reasoning tokens (SSE) for a specific task `job_id`."""
    async for event in _stream_thinking_sse(
        request=request,
        manager=manager,
        job_id=job_id,
        timeout=timeout,
    ):
        yield event


@router.post("/enqueue-import", response_model=EnqueueResponse)
def enqueue_import_endpoint(
    request: EnqueueImportRequest,
    config: DomainConfigDep,
    manager: QueueManagerDep,
):
    """Enqueue an imported `PatientMDTForm` file (Wave 1 Identification + Wave 2 Clinical + Wave 3 Experts) into the `PriorityQueue`."""
    if not is_safe_filename(request.filename):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Nom de fichier invalide.",
        )
    return manager.enqueue_import_file(
        filename=request.filename,
        target_patient_id=request.target_patient_id,
        batch_id=request.batch_id,
        include_clinical=request.include_clinical,
        total_clinical_models=request.total_clinical_models,
        total_expert_models=request.total_expert_models,
        domain=config.domain,
    )


@router.post("/rerun", response_model=EnqueueResponse)
def enqueue_rerun_endpoint(
    request: EnqueueRerunRequest,
    config: DomainConfigDep,
    manager: QueueManagerDep,
):
    """Enqueue a full or single-section rerun into the `PriorityQueue` for the target domain."""
    if not is_safe_filename(request.filename):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Nom de fichier invalide.",
        )
    return manager.enqueue_rcp_rerun(
        filename=request.filename,
        model_name=request.model_name,
        total_clinical_models=request.total_clinical_models,
        total_expert_models=request.total_expert_models,
        domain=config.domain,
        preserve_manual_edits=request.preserve_manual_edits,
    )


@router.post(
    "/jobs/retry",
    response_model=QueueJobResponse,
    dependencies=[Depends(require_admin)],
)
def retry_queue_job_by_query_endpoint(
    job_id: Annotated[str, Query()],
    manager: QueueManagerDep,
):
    """Re-enqueue a specific task by query parameter `job_id`."""
    return retry_queue_job_endpoint(job_id=job_id, manager=manager)


@router.post(
    "/jobs/{job_id}/retry",
    response_model=QueueJobResponse,
    dependencies=[Depends(require_admin)],
)
def retry_queue_job_endpoint(job_id: str, manager: QueueManagerDep):
    """Re-enqueue a specific task for execution (admin required when user headers are present)."""
    updated = manager.retry_job(job_id)
    if not updated:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tâche '{job_id}' introuvable.",
        )
    return updated


@router.delete(
    "/jobs",
    response_model=JobDeletedResponse,
    dependencies=[Depends(require_admin)],
)
def delete_queue_job_by_query_endpoint(
    job_id: Annotated[str, Query()],
    manager: QueueManagerDep,
):
    """Cancel or delete a task by query parameter `job_id`."""
    return delete_queue_job_endpoint(job_id=job_id, manager=manager)


@router.delete(
    "/jobs/{job_id}",
    response_model=JobDeletedResponse,
    dependencies=[Depends(require_admin)],
)
def delete_queue_job_endpoint(job_id: str, manager: QueueManagerDep):
    """Cancel or delete a task and release any associated execution lease (admin required when user headers are present)."""
    deleted = manager.cancel_or_delete_job(job_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Tâche '{job_id}' introuvable.",
        )
    return {"job_id": job_id, "deleted": True}


@router.post(
    "/clean",
    response_model=QueueCleanResponse,
    dependencies=[Depends(require_admin)],
)
def clean_queue_endpoint(
    http_request: Request,
    manager: QueueManagerDep,
    request: Annotated[QueueCleanRequest, Body()] = QueueCleanRequest(),
    domain: Annotated[Optional[str], Query()] = None,
):
    """Clean the processing queue according to the requested mode (per domain or globally)."""
    # `mode` is validated by `QueueCleanMode` (Literal): 422 if invalid.
    target_domain = getattr(http_request.state, "requested_domain", domain)
    return manager.clean_queue(mode=request.mode, domain=target_domain)


@router.get("/locks", response_model=list[GpuLeaseResponse])
def get_queue_locks_endpoint(manager: QueueManagerDep):
    """List active hardware execution slots (leases)."""
    return manager.get_all_gpu_leases()


@router.delete(
    "/locks",
    response_model=ReleaseLocksResponse,
    dependencies=[Depends(require_admin)],
)
def release_queue_locks_endpoint(
    request: Request,
    manager: QueueManagerDep,
    lease_id: Annotated[Optional[str], Query()] = None,
    job_id: Annotated[Optional[str], Query()] = None,
    domain: Annotated[Optional[str], Query()] = None,
    force_all: Annotated[bool, Query()] = False,
):
    """Release a specific lease, leases for a domain, or all active leases (requires `force_all=true`)."""
    target_domain = getattr(request.state, "requested_domain", domain)
    if not lease_id and not job_id and not target_domain and not force_all:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Paramètre requis : fournissez `lease_id`, `job_id`, `domain`, ou `force_all=true`.",
        )
    removed = manager.release_gpu_lease(
        lease_id=lease_id,
        job_id=job_id,
        domain=target_domain,
        force_all=force_all,
    )
    return {"released_locks": removed}
