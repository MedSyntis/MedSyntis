"""
OpenTelemetry Observability Integration for MedSyntis (`src/infrastructure/observability/otel.py`).

Relies directly on official OpenTelemetry Python bricks:
- `opentelemetry-api` & `opentelemetry-sdk` (`TracerProvider`, `MeterProvider`, `Resource`, `BatchSpanProcessor`,
  `PeriodicExportingMetricReader`, standard `OTEL_*` environment variables, and W3C `opentelemetry.propagate`).
- `opentelemetry-exporter-otlp-proto-http` & `opentelemetry-exporter-otlp-proto-grpc` (`OTLPSpanExporter`, `OTLPMetricExporter`).
- `opentelemetry-instrumentation-fastapi` (`FastAPIInstrumentor`), `opentelemetry-instrumentation-httpx` (`HTTPXClientInstrumentor`),
  `opentelemetry-instrumentation-pymongo` (`PymongoInstrumentor(capture_statement=False)`), and
  `opentelemetry-instrumentation-logging` (`LoggingInstrumentor`).

Adds only MedSyntis-specific HDS/GDPR guardrails (`SanitizingSpanProcessor` for Zero-PHI enforcement)
and strategic clinical/queue metrics (`MedSyntisMetrics`).
"""

from __future__ import annotations

from collections.abc import Generator, Iterator, Mapping, MutableMapping
from contextlib import contextmanager
import hashlib
import logging
import re
import threading
from typing import TYPE_CHECKING, Any
from urllib.parse import unquote

from opentelemetry import context as otel_context, metrics, propagate, trace
from opentelemetry.attributes import BoundedAttributes
from opentelemetry.baggage.propagation import W3CBaggagePropagator
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.grpc.metric_exporter import (
    OTLPMetricExporter as GrpcOTLPMetricExporter,
)
from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import (
    OTLPSpanExporter as GrpcOTLPSpanExporter,
)
from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
    OTLPMetricExporter as HttpOTLPMetricExporter,
)
from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
    OTLPSpanExporter as HttpOTLPSpanExporter,
)
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.instrumentation.logging import LoggingInstrumentor
from opentelemetry.instrumentation.pymongo import PymongoInstrumentor
from opentelemetry.metrics import CallbackOptions, Meter, NoOpMeterProvider, Observation
from opentelemetry.propagators.composite import CompositePropagator
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import (
    ConsoleMetricExporter,
    MetricExporter,
    PeriodicExportingMetricReader,
)
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor, TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    ConsoleSpanExporter,
    SimpleSpanProcessor,
    SpanExporter,
)
from opentelemetry.sdk.trace.sampling import (
    ALWAYS_OFF,
    ALWAYS_ON,
    ParentBased,
    Sampler,
    TraceIdRatioBased,
)
from opentelemetry.trace import NoOpTracerProvider, SpanKind, Status, StatusCode, Tracer
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

if TYPE_CHECKING:
    from fastapi import FastAPI

    from src.application.config import AppConfig

_INTERNAL_LOGGER = logging.getLogger("medsyntis.observability")

_PSEUDONYMIZED_PATIENT_ID_RE = re.compile(r"^(?:pat|patient)_[0-9a-f]{16}$")
_PSEUDONYMIZED_DOC_ID_RE = re.compile(
    r"^(?:doc_[0-9a-f]{16}(?:\.pdf)?|[0-9a-f]{16,64})$"
)
_MAX_ATTR_STR_LEN = 256

_FORBIDDEN_ATTR_KEYS = frozenset(
    {
        "first_name",
        "last_name",
        "patient_name",
        "full_name",
        "patient_label",
        "date_birth",
        "birth_date",
        "dob",
        "nir",
        "ins",
        "email",
        "phone",
        "address",
        "prompt",
        "system_prompt",
        "question",
        "query",
        "completion",
        "response",
        "thinking",
        "reasoning",
        "markdown",
        "content",
        "original_filename",
        "raw_text",
        "clinical_text",
        "summary_text",
        "db.statement",
    }
)

_PATIENT_ID_KEYS = frozenset(
    {
        "patient_id",
        "target_patient_id",
        "resolved_patient_id",
        "medsyntis.patient_id",
    }
)

_DOCUMENT_ID_KEYS = frozenset(
    {
        "filename",
        "file",
        "document",
        "medsyntis.doc_id",
    }
)


def _hash_opaque_identifier(raw_value: str) -> str:
    digest = hashlib.sha256(raw_value.encode("utf-8")).hexdigest()[:12]
    return f"sha256:{digest}"


def _sanitize_single_value(key: str, value: Any) -> Any:
    lower_key = key.strip().lower()
    leaf_key = lower_key.rsplit(".", 1)[-1]
    if lower_key in _FORBIDDEN_ATTR_KEYS or leaf_key in _FORBIDDEN_ATTR_KEYS:
        return None
    if value is None:
        return None

    if lower_key in _PATIENT_ID_KEYS or leaf_key in _PATIENT_ID_KEYS:
        str_val = str(value).strip()
        return str_val if _PSEUDONYMIZED_PATIENT_ID_RE.match(str_val) else "[REDACTED]"

    if lower_key in _DOCUMENT_ID_KEYS or leaf_key in _DOCUMENT_ID_KEYS:
        str_val = str(value).strip()
        if not str_val:
            return None
        return (
            str_val
            if _PSEUDONYMIZED_DOC_ID_RE.match(str_val)
            else _hash_opaque_identifier(str_val)
        )

    if isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        return value[:_MAX_ATTR_STR_LEN]
    if isinstance(value, (list, tuple)):
        return tuple(
            item
            if isinstance(item, (bool, int, float))
            else str(item)[:_MAX_ATTR_STR_LEN]
            for item in value[:32]
            if item is not None
        )
    return str(value)[:_MAX_ATTR_STR_LEN]


def sanitize_otel_attributes(
    attributes: Mapping[str, Any] | None,
) -> dict[str, Any]:
    """Scrub clinical/identity PHI fields from OpenTelemetry span or metric attributes."""
    if not attributes:
        return {}
    cleaned: dict[str, Any] = {}
    for raw_key, raw_val in attributes.items():
        if not isinstance(raw_key, str) or not raw_key.strip():
            continue
        sanitized_val = _sanitize_single_value(raw_key, raw_val)
        if sanitized_val is not None:
            cleaned[raw_key] = sanitized_val
    return cleaned


class SanitizingSpanProcessor(SpanProcessor):
    """Official `SpanProcessor` enforcing Zero-PHI attributes on every span before export."""

    def on_start(self, span: Span, parent_context: Context | None = None) -> None:
        self._scrub_span_in_place(span)

    def on_end(self, span: ReadableSpan) -> None:
        self._scrub_span_in_place(span)

    @staticmethod
    def _scrub_span_in_place(span: Any) -> None:
        raw_attrs = getattr(span, "_attributes", None)
        if not raw_attrs:
            return
        is_immutable = bool(getattr(raw_attrs, "_immutable", False))
        lock = getattr(span, "_lock", None)
        if lock is not None:
            with lock:
                sanitized = sanitize_otel_attributes(dict(raw_attrs))
                span._attributes = BoundedAttributes(  # noqa: SLF001
                    attributes=sanitized,
                    immutable=is_immutable,
                )
        else:
            sanitized = sanitize_otel_attributes(dict(raw_attrs))
            span._attributes = BoundedAttributes(  # noqa: SLF001
                attributes=sanitized,
                immutable=is_immutable,
            )

    def shutdown(self) -> None:
        return None

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return True


def parse_otlp_headers(raw: str | None) -> dict[str, str]:
    """Parse comma-separated `OTEL_EXPORTER_OTLP_HEADERS` (`k=v,k2=v2`) with URL-unquoting."""
    if not raw or not raw.strip():
        return {}
    out: dict[str, str] = {}
    for entry in raw.split(","):
        part = entry.strip()
        if not part or "=" not in part:
            continue
        k, v = part.split("=", 1)
        if k.strip():
            out[k.strip()] = unquote(v.strip())
    return out


_parse_key_value_pairs = parse_otlp_headers


def _resolve_http_signal_endpoint(
    specific_endpoint: str, base_endpoint: str, signal_path: str
) -> str | None:
    if specific_endpoint.strip():
        return specific_endpoint.strip()
    base = base_endpoint.strip().rstrip("/")
    if not base:
        return None
    return base if base.endswith(signal_path) else f"{base}{signal_path}"


def _observe_queue_depth(_options: CallbackOptions) -> Iterator[Observation]:
    """Observable gauge callback reporting live GPU PriorityQueue depth & active leases."""
    try:
        from src.infrastructure.queue.memory_queue import _GLOBAL_MANAGER

        mgr = _GLOBAL_MANAGER
        if mgr is None:
            yield Observation(0, {"state": "pending"})
            yield Observation(0, {"state": "processing"})
            yield Observation(0, {"state": "active_leases"})
            return
        stats = mgr.get_queue_stats()
        yield Observation(int(stats.get("pending", 0)), {"state": "pending"})
        yield Observation(int(stats.get("processing", 0)), {"state": "processing"})
        yield Observation(int(stats.get("active_locks", 0)), {"state": "active_leases"})
    except Exception:
        return


class MedSyntisMetrics:
    """Strategic clinical & operational OpenTelemetry metrics built on official `Meter` instruments."""

    def __init__(self, meter: Meter, enabled: bool) -> None:
        self.enabled = enabled
        self._queue_enqueued = meter.create_counter(
            "medsyntis.queue.enqueued.total",
            description="Total background jobs enqueued into the GPU PriorityQueue",
        )
        self._queue_wait = meter.create_histogram(
            "medsyntis.queue.wait_duration_ms",
            unit="ms",
            description="Time spent waiting in the PriorityQueue before worker claim",
        )
        self._queue_job_duration = meter.create_histogram(
            "medsyntis.queue.job.duration_ms",
            unit="ms",
            description="Execution duration of a claimed PriorityQueue job",
        )
        self._queue_jobs_total = meter.create_counter(
            "medsyntis.queue.jobs.total",
            description="Terminal PriorityQueue job outcomes (completed, failed, rejected_non_mdt)",
        )
        self._extraction_duration = meter.create_histogram(
            "medsyntis.extraction.section.duration_ms",
            unit="ms",
            description="Duration of clinical/expert section extraction per wave",
        )
        self._manual_edits = meter.create_counter(
            "medsyntis.manual_edits.total",
            description="Human-in-the-loop manual section edits and rollbacks",
        )
        self._llm_requests = meter.create_counter(
            "medsyntis.llm.requests.total",
            description="Total local LLM agent/model invocations",
        )
        self._llm_duration = meter.create_histogram(
            "medsyntis.llm.duration_ms",
            unit="ms",
            description="Local LLM invocation latency in milliseconds",
        )
        self._llm_tokens = meter.create_counter(
            "medsyntis.llm.token.usage",
            description="Local LLM input and output token consumption",
        )
        self._embed_cache = meter.create_counter(
            "medsyntis.embeddings.cache.requests",
            description="Embedding LRU cache hit and miss counts",
        )
        self._doc_parse = meter.create_histogram(
            "medsyntis.document.parse.duration_ms",
            unit="ms",
            description="Document parsing and vector indexing duration in milliseconds",
        )
        self._vectordb_duration = meter.create_histogram(
            "medsyntis.vectordb.operation.duration_ms",
            unit="ms",
            description="Vector store search and batch indexing latency",
        )
        if enabled:
            meter.create_observable_gauge(
                "medsyntis.queue.depth",
                callbacks=[_observe_queue_depth],
                description="Live GPU PriorityQueue depth by state (pending, processing, active_leases)",
            )

    def record_queue_enqueue(
        self, *, domain: str, job_type: str, count: int = 1
    ) -> None:
        if not self.enabled or count <= 0:
            return
        self._queue_enqueued.add(
            count,
            sanitize_otel_attributes(
                {"medsyntis.domain": domain, "medsyntis.job_type": job_type}
            ),
        )

    def record_queue_job(
        self,
        *,
        domain: str,
        job_type: str,
        status: str,
        wait_ms: float,
        duration_ms: float,
    ) -> None:
        if not self.enabled:
            return
        base_attrs = sanitize_otel_attributes(
            {"medsyntis.domain": domain, "medsyntis.job_type": job_type}
        )
        outcome_attrs = sanitize_otel_attributes(
            {
                "medsyntis.domain": domain,
                "medsyntis.job_type": job_type,
                "medsyntis.status": status,
            }
        )
        self._queue_wait.record(max(0.0, float(wait_ms)), base_attrs)
        self._queue_job_duration.record(max(0.0, float(duration_ms)), outcome_attrs)
        self._queue_jobs_total.add(1, outcome_attrs)

    def record_extraction_section(
        self,
        *,
        domain: str,
        wave: str,
        section: str,
        status: str,
        duration_ms: float,
    ) -> None:
        if not self.enabled:
            return
        self._extraction_duration.record(
            max(0.0, float(duration_ms)),
            sanitize_otel_attributes(
                {
                    "medsyntis.domain": domain,
                    "medsyntis.wave": wave,
                    "medsyntis.section": section,
                    "medsyntis.status": status,
                }
            ),
        )

    def record_manual_edit(self, *, domain: str, section: str, action: str) -> None:
        if not self.enabled:
            return
        self._manual_edits.add(
            1,
            sanitize_otel_attributes(
                {
                    "medsyntis.domain": domain,
                    "medsyntis.section": section,
                    "medsyntis.action": action,
                }
            ),
        )

    def record_llm_call(
        self,
        *,
        provider: str,
        model: str,
        operation: str,
        status: str,
        duration_ms: float,
        input_tokens: int = 0,
        output_tokens: int = 0,
    ) -> None:
        if not self.enabled:
            return
        attrs = sanitize_otel_attributes(
            {
                "gen_ai.system": provider,
                "gen_ai.request.model": model,
                "gen_ai.operation.name": operation,
                "medsyntis.status": status,
            }
        )
        self._llm_requests.add(1, attrs)
        self._llm_duration.record(max(0.0, float(duration_ms)), attrs)
        if input_tokens > 0:
            self._llm_tokens.add(
                input_tokens,
                sanitize_otel_attributes(
                    {
                        "gen_ai.system": provider,
                        "gen_ai.request.model": model,
                        "gen_ai.token.type": "input",
                    }
                ),
            )
        if output_tokens > 0:
            self._llm_tokens.add(
                output_tokens,
                sanitize_otel_attributes(
                    {
                        "gen_ai.system": provider,
                        "gen_ai.request.model": model,
                        "gen_ai.token.type": "output",
                    }
                ),
            )

    def record_embedding_cache(self, *, model: str, hit: bool) -> None:
        if not self.enabled:
            return
        self._embed_cache.add(
            1,
            sanitize_otel_attributes(
                {
                    "gen_ai.request.model": model or "default",
                    "cache.result": "hit" if hit else "miss",
                }
            ),
        )

    def record_document_parse(
        self,
        *,
        domain: str,
        parser: str,
        cache_hit: bool,
        duration_ms: float,
    ) -> None:
        if not self.enabled:
            return
        self._doc_parse.record(
            max(0.0, float(duration_ms)),
            sanitize_otel_attributes(
                {
                    "medsyntis.domain": domain,
                    "medsyntis.parser": parser,
                    "cache.hit": cache_hit,
                }
            ),
        )

    def record_vectordb_op(
        self,
        *,
        backend: str,
        operation: str,
        domain: str,
        duration_ms: float,
    ) -> None:
        if not self.enabled:
            return
        self._vectordb_duration.record(
            max(0.0, float(duration_ms)),
            sanitize_otel_attributes(
                {
                    "db.system": backend,
                    "db.operation.name": operation,
                    "medsyntis.domain": domain,
                }
            ),
        )


_STATE_LOCK = threading.Lock()
_CONFIGURED = False
_ENABLED = False
_AUTO_INSTRUMENTORS_ACTIVE = False
_TRACER_PROVIDER: TracerProvider | NoOpTracerProvider = NoOpTracerProvider()
_METER_PROVIDER: MeterProvider | NoOpMeterProvider = NoOpMeterProvider()
_METRICS = MedSyntisMetrics(_METER_PROVIDER.get_meter("medsyntis"), enabled=False)


def _build_sampler(sampler_name: str, ratio: float) -> Sampler:
    clamped = max(0.0, min(1.0, float(ratio)))
    norm = (sampler_name or "parentbased_traceidratio").strip().lower()
    if norm == "always_on":
        return ALWAYS_ON
    if norm == "always_off":
        return ALWAYS_OFF
    if norm == "traceidratio":
        return TraceIdRatioBased(clamped)
    if norm == "parentbased_always_on":
        return ParentBased(ALWAYS_ON)
    if norm == "parentbased_always_off":
        return ParentBased(ALWAYS_OFF)
    return ParentBased(TraceIdRatioBased(clamped))


def _configure_propagators(raw_propagators: str) -> None:
    names = {
        p.strip().lower()
        for p in (raw_propagators or "tracecontext,baggage").split(",")
        if p.strip()
    }
    propagators: list[Any] = []
    if "tracecontext" in names or not names:
        propagators.append(TraceContextTextMapPropagator())
    if "baggage" in names:
        propagators.append(W3CBaggagePropagator())
    propagate.set_global_textmap(CompositePropagator(propagators))


def _build_official_span_exporter(otel_cfg: Any) -> SpanExporter | None:
    exporter_kind = (otel_cfg.traces_exporter or "none").strip().lower()
    if exporter_kind in ("", "none"):
        return None
    if exporter_kind == "console":
        return ConsoleSpanExporter()
    if exporter_kind == "otlp":
        headers = _parse_key_value_pairs(otel_cfg.exporter_otlp_headers) or None
        timeout_sec = max(1, int(otel_cfg.exporter_otlp_timeout // 1000))
        protocol = (otel_cfg.exporter_otlp_protocol or "http/protobuf").strip().lower()
        if protocol == "grpc":
            endpoint = (
                otel_cfg.exporter_otlp_traces_endpoint.strip()
                or otel_cfg.exporter_otlp_endpoint.strip()
                or None
            )
            return GrpcOTLPSpanExporter(
                endpoint=endpoint,
                headers=tuple(headers.items()) if headers else None,
                timeout=timeout_sec,
            )
        endpoint = _resolve_http_signal_endpoint(
            otel_cfg.exporter_otlp_traces_endpoint,
            otel_cfg.exporter_otlp_endpoint,
            "/v1/traces",
        )
        return HttpOTLPSpanExporter(
            endpoint=endpoint,
            headers=headers,
            timeout=timeout_sec,
        )
    _INTERNAL_LOGGER.warning(
        "Unsupported OTEL_TRACES_EXPORTER=%r; falling back to 'none'",
        exporter_kind,
    )
    return None


def _build_official_metric_reader(otel_cfg: Any) -> Any | None:
    exporter_kind = (otel_cfg.metrics_exporter or "none").strip().lower()
    if exporter_kind in ("", "none"):
        return None
    interval_ms = max(1000, int(otel_cfg.metric_export_interval))
    if exporter_kind == "console":
        return PeriodicExportingMetricReader(
            ConsoleMetricExporter(), export_interval_millis=interval_ms
        )
    if exporter_kind == "otlp":
        headers = _parse_key_value_pairs(otel_cfg.exporter_otlp_headers) or None
        timeout_sec = max(1, int(otel_cfg.exporter_otlp_timeout // 1000))
        protocol = (otel_cfg.exporter_otlp_protocol or "http/protobuf").strip().lower()
        if protocol == "grpc":
            endpoint = (
                otel_cfg.exporter_otlp_metrics_endpoint.strip()
                or otel_cfg.exporter_otlp_endpoint.strip()
                or None
            )
            exporter: MetricExporter = GrpcOTLPMetricExporter(
                endpoint=endpoint,
                headers=tuple(headers.items()) if headers else None,
                timeout=timeout_sec,
            )
        else:
            endpoint = _resolve_http_signal_endpoint(
                otel_cfg.exporter_otlp_metrics_endpoint,
                otel_cfg.exporter_otlp_endpoint,
                "/v1/metrics",
            )
            exporter = HttpOTLPMetricExporter(
                endpoint=endpoint,
                headers=headers,
                timeout=timeout_sec,
            )
        return PeriodicExportingMetricReader(
            exporter, export_interval_millis=interval_ms
        )
    _INTERNAL_LOGGER.warning(
        "Unsupported OTEL_METRICS_EXPORTER=%r; falling back to 'none'",
        exporter_kind,
    )
    return None


def _install_global_providers(tracer_provider: Any, meter_provider: Any) -> None:
    trace._TRACER_PROVIDER = tracer_provider  # noqa: SLF001
    t_once = getattr(trace, "_TRACER_PROVIDER_SET_ONCE", None)
    if t_once is not None and hasattr(t_once, "_done"):
        t_once._done = True  # noqa: SLF001

    metrics._internal._METER_PROVIDER = meter_provider  # noqa: SLF001
    m_once = getattr(metrics._internal, "_METER_PROVIDER_SET_ONCE", None)
    if m_once is not None and hasattr(m_once, "_done"):
        m_once._done = True  # noqa: SLF001


def _enable_library_instrumentors() -> None:
    global _AUTO_INSTRUMENTORS_ACTIVE
    if _AUTO_INSTRUMENTORS_ACTIVE:
        return
    HTTPXClientInstrumentor().instrument()
    PymongoInstrumentor().instrument(capture_statement=False)
    LoggingInstrumentor().instrument(set_logging_format=False)
    _AUTO_INSTRUMENTORS_ACTIVE = True


def _disable_library_instrumentors() -> None:
    global _AUTO_INSTRUMENTORS_ACTIVE
    if not _AUTO_INSTRUMENTORS_ACTIVE:
        return
    for inst_cls in (
        HTTPXClientInstrumentor,
        PymongoInstrumentor,
        LoggingInstrumentor,
    ):
        try:
            inst_cls().uninstrument()
        except Exception:
            pass
    _AUTO_INSTRUMENTORS_ACTIVE = False


def configure_observability(
    config: AppConfig,
    *,
    service_name_override: str | None = None,
    span_exporter: SpanExporter | None = None,
    metric_reader: Any | None = None,
    enable_auto_instrumentation: bool = True,
    force: bool = False,
) -> None:
    """
    Configure official OpenTelemetry `TracerProvider`, `MeterProvider`, OTLP exporters,
    and library auto-instrumentors (`httpx`, `pymongo`, `logging`) from `config.otel`.
    """
    global _CONFIGURED, _ENABLED, _TRACER_PROVIDER, _METER_PROVIDER, _METRICS

    with _STATE_LOCK:
        if _CONFIGURED and not force:
            return

        _shutdown_locked()
        otel_cfg = config.otel
        _configure_propagators(otel_cfg.propagators)

        if otel_cfg.sdk_disabled:
            _CONFIGURED = True
            return

        extra_res = _parse_key_value_pairs(otel_cfg.resource_attributes)
        service_name = (
            service_name_override
            or extra_res.get("service.name")
            or otel_cfg.service_name
            or "medsyntis-api"
        )
        resource = Resource.create(
            {
                "service.name": service_name,
                "service.version": "1.1.0",
                "deployment.environment": (
                    "development" if config.dev_mode else "production"
                ),
                "medsyntis.domain": config.domain or "oncology",
                "medsyntis.hardware_profile": config.queue.hardware_profile,
                **sanitize_otel_attributes(extra_res),
            }
        )
        sampler = _build_sampler(otel_cfg.traces_sampler, otel_cfg.traces_sampler_arg)
        tracer_provider = TracerProvider(resource=resource, sampler=sampler)
        tracer_provider.add_span_processor(SanitizingSpanProcessor())

        effective_span_exporter = span_exporter or _build_official_span_exporter(
            otel_cfg
        )
        if effective_span_exporter is not None:
            if span_exporter is not None or isinstance(
                effective_span_exporter, ConsoleSpanExporter
            ):
                tracer_provider.add_span_processor(
                    SimpleSpanProcessor(effective_span_exporter)
                )
            else:
                tracer_provider.add_span_processor(
                    BatchSpanProcessor(effective_span_exporter)
                )

        readers: list[Any] = []
        effective_metric_reader = metric_reader or _build_official_metric_reader(
            otel_cfg
        )
        if effective_metric_reader is not None:
            readers.append(effective_metric_reader)

        meter_provider = MeterProvider(resource=resource, metric_readers=readers)

        _ENABLED = True
        _TRACER_PROVIDER = tracer_provider
        _METER_PROVIDER = meter_provider
        _install_global_providers(tracer_provider, meter_provider)
        _METRICS = MedSyntisMetrics(
            meter_provider.get_meter("medsyntis", "1.1.0"), enabled=True
        )
        if enable_auto_instrumentation:
            _enable_library_instrumentors()
        _CONFIGURED = True


def _fastapi_server_request_hook(span: Any, scope: dict[str, Any]) -> None:
    if span is None or not span.is_recording():
        return
    for raw_k, raw_v in scope.get("headers") or ():
        if raw_k.lower() == b"x-medsyntis-domain":
            try:
                span.set_attribute(
                    "medsyntis.domain", raw_v.decode("latin1").strip().lower()
                )
            except Exception:
                pass
            break


def _fastapi_client_response_hook(
    span: Any, scope: dict[str, Any], message: dict[str, Any]
) -> None:
    if message.get("type") != "http.response.start":
        return
    trace_id, _ = get_active_trace_ids()
    if not trace_id and span is not None and span.is_recording():
        ctx = span.get_span_context()
        if ctx is not None and ctx.is_valid:
            trace_id = f"{ctx.trace_id:032x}"
    if trace_id:
        headers = list(message.get("headers") or [])
        if not any(k.lower() == b"x-trace-id" for k, _ in headers):
            headers.append((b"x-trace-id", trace_id.encode("ascii")))
            message["headers"] = headers


def instrument_fastapi_app(target_app: FastAPI) -> None:
    """
    Instrument a `FastAPI` application using the official `FastAPIInstrumentor`,
    excluding noisy ASGI receive/send child spans on SSE streams and attaching `X-Trace-Id`.
    """
    if getattr(target_app, "_is_instrumented_by_opentelemetry", False):
        return

    @target_app.middleware("http")
    async def _attach_x_trace_id_header(request: Any, call_next: Any) -> Any:
        response = await call_next(request)
        trace_id, _ = get_active_trace_ids()
        if trace_id and "X-Trace-Id" not in response.headers:
            response.headers["X-Trace-Id"] = trace_id
        return response

    FastAPIInstrumentor.instrument_app(
        target_app,
        server_request_hook=_fastapi_server_request_hook,
        client_response_hook=_fastapi_client_response_hook,
        excluded_urls="^/health$",
        exclude_spans=["receive", "send"],
    )


def _shutdown_locked() -> None:
    global _CONFIGURED, _ENABLED, _TRACER_PROVIDER, _METER_PROVIDER, _METRICS
    _disable_library_instrumentors()
    if isinstance(_TRACER_PROVIDER, TracerProvider):
        try:
            _TRACER_PROVIDER.shutdown()
        except Exception:
            pass
    if isinstance(_METER_PROVIDER, MeterProvider):
        try:
            _METER_PROVIDER.shutdown()
        except Exception:
            pass
    _ENABLED = False
    _CONFIGURED = False
    _TRACER_PROVIDER = NoOpTracerProvider()
    _METER_PROVIDER = NoOpMeterProvider()
    _install_global_providers(_TRACER_PROVIDER, _METER_PROVIDER)
    _METRICS = MedSyntisMetrics(_METER_PROVIDER.get_meter("medsyntis"), enabled=False)


def shutdown_observability() -> None:
    """Flush and shut down active OpenTelemetry SDK providers cleanly."""
    with _STATE_LOCK:
        _shutdown_locked()


def reset_observability_for_tests() -> None:
    """Reset OpenTelemetry providers and auto-instrumentors to clean No-Op defaults."""
    shutdown_observability()


def is_observability_enabled() -> bool:
    """Return True when OpenTelemetry SDK is active (`OTEL_SDK_DISABLED=false`)."""
    return _ENABLED


def get_tracer(name: str = "medsyntis") -> Tracer:
    """Return an OpenTelemetry `Tracer` from the global/active provider."""
    return trace.get_tracer(name, "1.1.0")


def get_meter(name: str = "medsyntis") -> Meter:
    """Return an OpenTelemetry `Meter` from the global/active provider."""
    return metrics.get_meter(name, "1.1.0")


def get_metrics() -> MedSyntisMetrics:
    """Return the active Zero-PHI `MedSyntisMetrics` instruments facade."""
    return _METRICS


def record_manual_edit(*, domain: str, section: str, action: str) -> None:
    """Record a clinician manual section edit (`update` or `rollback`)."""
    _METRICS.record_manual_edit(domain=domain, section=section, action=action)


def get_active_trace_ids() -> tuple[str | None, str | None]:
    """Return `(trace_id_hex, span_id_hex)` when an active recording span exists."""
    if not _ENABLED:
        return None, None
    span = trace.get_current_span()
    if span is None or not span.is_recording():
        return None, None
    ctx = span.get_span_context()
    if ctx is None or not ctx.is_valid:
        return None, None
    return f"{ctx.trace_id:032x}", f"{ctx.span_id:016x}"


def inject_trace_context(
    carrier: MutableMapping[str, str] | None = None,
) -> dict[str, str]:
    """Inject active W3C `traceparent`/`tracestate` into `carrier` via `opentelemetry.propagate`."""
    out: dict[str, str] = dict(carrier) if carrier is not None else {}
    if not _ENABLED:
        return out
    propagate.inject(out)
    if carrier is not None:
        carrier.update(out)
    return out


def extract_trace_context(
    carrier: Mapping[str, str] | None,
) -> Context | None:
    """Extract parent `Context` from `carrier` via official `opentelemetry.propagate`."""
    if not _ENABLED or not carrier:
        return None
    normalized = {
        k.lower(): v
        for k, v in carrier.items()
        if isinstance(k, str) and isinstance(v, str)
    }
    if "traceparent" not in normalized and "baggage" not in normalized:
        return None
    return propagate.extract(normalized, context=otel_context.Context())


@contextmanager
def start_span(
    name: str,
    *,
    kind: SpanKind = SpanKind.INTERNAL,
    attributes: Mapping[str, Any] | None = None,
    context: Context | None = None,
) -> Generator[trace.Span, None, None]:
    """Start a Zero-PHI sanitized OpenTelemetry span using `trace.get_tracer(...)`."""
    if not _ENABLED:
        yield trace.INVALID_SPAN
        return

    tracer = trace.get_tracer("medsyntis", "1.1.0")
    safe_attrs = sanitize_otel_attributes(attributes)
    with tracer.start_as_current_span(
        name,
        context=context,
        kind=kind,
        attributes=safe_attrs,
        record_exception=False,
        set_status_on_exception=False,
    ) as span:
        try:
            yield span
        except Exception as exc:
            if span.is_recording():
                err_type = type(exc).__name__
                span.set_attribute("error.type", err_type)
                span.set_status(Status(StatusCode.ERROR, err_type))
            raise
