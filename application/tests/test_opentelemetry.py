"""
TDD test suite for End-to-End OpenTelemetry Observability (MedSyntis#14).

Covers:
1. Official `OTEL_*` environment variables (`OTelSettings`) and safe defaults (`OTEL_SDK_DISABLED=true`, stdout logs, No-Op tracing/metrics).
2. Local sovereignty guardrail (`APP_ALLOW_REMOTE_LLM=false` blocks non-local OTLP endpoints while allowing local Docker services like `http://mlflow:5000`).
3. Zero-PHI span & metric attribute sanitization (`SanitizingSpanProcessor` + `sanitize_otel_attributes`).
4. Automatic `trace_id` and `span_id` correlation in text and JSON `stdout` logs when a span is recording.
5. End-to-end W3C `traceparent` propagation: FastAPI HTTP ingress -> `InMemoryQueueManager` enqueue -> worker execution (Wave 1/2/3) -> DocumentReader / CachedEmbeddingsProxy / MedSyntisAgent / MongoDB.
6. Pertinent clinical & operational OpenTelemetry metrics (`Counter` & `Histogram` instruments), including `medsyntis.manual_edits.total`.
7. Official OTLP HTTP/Protobuf exporter (`application/x-protobuf` + `OTEL_EXPORTER_OTLP_HEADERS` for MLflow `/v1/traces`).
8. Optional hardened `mlflow` service (`--profile mlflow`) in `dist/docker/compose/docker-compose.prod.yml` and `start-prod-mlflow` in `Makefile`.
"""

from __future__ import annotations

import io
import json
import logging
import os
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

os.environ.setdefault("LITELLM_LOCAL_MODEL_COST_MAP", "True")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
import pytest
import yaml

from src.application.config import AppConfig, OTelSettings
from src.infrastructure.llm.base import CachedEmbeddingsProxy
from src.infrastructure.observability.otel import (
    configure_observability,
    extract_trace_context,
    get_metrics,
    get_tracer,
    inject_trace_context,
    instrument_fastapi_app,
    parse_otlp_headers,
    record_manual_edit,
    reset_observability_for_tests,
    sanitize_otel_attributes,
    start_span,
)
from src.domain.worker import JobStatus
from src.infrastructure.queue.memory_queue import InMemoryQueueManager


REPO_ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def _clean_otel_state(monkeypatch: pytest.MonkeyPatch):
    """Ensure clean OpenTelemetry global state before and after every test."""
    for key in (
        "OTEL_SDK_DISABLED",
        "OTEL_SERVICE_NAME",
        "OTEL_RESOURCE_ATTRIBUTES",
        "OTEL_TRACES_EXPORTER",
        "OTEL_METRICS_EXPORTER",
        "OTEL_LOGS_EXPORTER",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
        "OTEL_EXPORTER_OTLP_PROTOCOL",
        "OTEL_EXPORTER_OTLP_HEADERS",
        "OTEL_TRACES_SAMPLER",
        "OTEL_TRACES_SAMPLER_ARG",
        "OTEL_PROPAGATORS",
    ):
        monkeypatch.delenv(key, raising=False)
    reset_observability_for_tests()
    yield
    reset_observability_for_tests()


def test_otel_settings_safe_defaults_disabled_by_default():
    """Verify official OTEL_* settings default to disabled (No-Op) and stdout-only logging."""
    conf = AppConfig()
    assert isinstance(conf.otel, OTelSettings)
    assert conf.otel.sdk_disabled is True
    assert conf.otel.traces_exporter == "none"
    assert conf.otel.metrics_exporter == "none"
    assert conf.otel.logs_exporter == "none"
    assert conf.otel.exporter_otlp_protocol == "http/protobuf"
    assert conf.otel.traces_sampler == "parentbased_traceidratio"
    assert conf.otel.traces_sampler_arg == pytest.approx(1.0)

    configure_observability(conf)
    tracer = get_tracer("test")
    with tracer.start_as_current_span("noop-span") as span:
        assert span.is_recording() is False


def test_otel_settings_reads_official_env_vars_and_propagates_across_domains(
    monkeypatch: pytest.MonkeyPatch,
):
    """Verify official OTEL_* env vars populate OTelSettings and survive AppConfig.for_domain()."""
    monkeypatch.setenv("OTEL_SDK_DISABLED", "false")
    monkeypatch.setenv("OTEL_SERVICE_NAME", "medsyntis-api-prod")
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "otlp")
    monkeypatch.setenv("OTEL_METRICS_EXPORTER", "console")
    monkeypatch.setenv(
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://mlflow:5000/v1/traces"
    )
    monkeypatch.setenv(
        "OTEL_EXPORTER_OTLP_HEADERS",
        "x-mlflow-experiment-id=0,Authorization=Bearer%20tok",
    )
    monkeypatch.setenv("OTEL_TRACES_SAMPLER_ARG", "0.5")

    conf = AppConfig()
    assert conf.otel.sdk_disabled is False
    assert conf.otel.service_name == "medsyntis-api-prod"
    assert conf.otel.traces_exporter == "otlp"
    assert conf.otel.metrics_exporter == "console"
    assert conf.otel.exporter_otlp_traces_endpoint == "http://mlflow:5000/v1/traces"
    assert conf.otel.traces_sampler_arg == pytest.approx(0.5)
    assert parse_otlp_headers(conf.otel.exporter_otlp_headers) == {
        "x-mlflow-experiment-id": "0",
        "Authorization": "Bearer tok",
    }

    sma_conf = conf.for_domain("sma")
    assert sma_conf.otel.sdk_disabled is False
    assert sma_conf.otel.exporter_otlp_traces_endpoint == "http://mlflow:5000/v1/traces"


def test_local_sovereignty_guardrail_blocks_remote_otlp_endpoint(
    monkeypatch: pytest.MonkeyPatch,
):
    """Refuse public cloud OTLP endpoints when APP_ALLOW_REMOTE_LLM=false (HDS/GDPR guardrail)."""
    monkeypatch.setenv("APP_ALLOW_REMOTE_LLM", "false")
    monkeypatch.setenv("OTEL_SDK_DISABLED", "false")
    monkeypatch.setenv("OTEL_TRACES_EXPORTER", "otlp")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "https://api.honeycomb.io:443")

    with pytest.raises(ValueError, match="OTLP"):
        AppConfig()

    # Local Docker service (`mlflow`) and loopback (`127.0.0.1`) must pass
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://mlflow:5000")
    valid_conf = AppConfig()
    assert valid_conf.otel.exporter_otlp_endpoint == "http://mlflow:5000"


def test_zero_phi_sanitizer_strips_clinical_and_identity_fields():
    """Ensure raw patient names, birth dates, prompts, and cleartext filenames never enter spans."""
    raw_attrs: dict[str, Any] = {
        "medsyntis.domain": "oncology",
        "medsyntis.wave": "wave_2_clinical",
        "medsyntis.section": "CancerDescription",
        "medsyntis.patient_id": "pat_0123456789abcdef",
        "medsyntis.doc_id": "doc_fedcba9876543210.pdf",
        "first_name": "Jean",
        "last_name": "DUPONT",
        "date_birth": "1958-04-12",
        "prompt": "Patient Jean DUPONT presents cT3N1 adenocarcinoma",
        "thinking": "<think>Analyzing patient Jean DUPONT</think>",
        "original_filename": "DUPONT_Jean_1958_RCP.pdf",
        "filename": "DUPONT_Jean_1958_RCP.pdf",
        "untrusted_patient_id_key": "DUPONT_JEAN_1958",
    }
    # Check both direct sanitization and SanitizingSpanProcessor enforcement
    sanitized = sanitize_otel_attributes(
        {
            **raw_attrs,
            "patient_id": "DUPONT_JEAN_1958",
        }
    )
    assert sanitized["medsyntis.domain"] == "oncology"
    assert sanitized["medsyntis.section"] == "CancerDescription"
    assert sanitized["medsyntis.patient_id"] == "pat_0123456789abcdef"
    assert sanitized["medsyntis.doc_id"] == "doc_fedcba9876543210.pdf"
    assert "first_name" not in sanitized
    assert "last_name" not in sanitized
    assert "date_birth" not in sanitized
    assert "prompt" not in sanitized
    assert "thinking" not in sanitized
    assert "original_filename" not in sanitized
    assert "DUPONT" not in str(sanitized.get("filename", ""))
    assert str(sanitized.get("filename", "")).startswith("sha256:")
    assert sanitized["patient_id"] == "[REDACTED]"

    # Verify SanitizingSpanProcessor also scrubs attributes set directly on a live span
    exporter = InMemorySpanExporter()
    conf = AppConfig(otel=OTelSettings(sdk_disabled=False, traces_exporter="none"))
    configure_observability(conf, span_exporter=exporter, force=True)

    with start_span("test.phi_guard", attributes={"medsyntis.domain": "sma"}) as span:
        span.set_attribute("first_name", "Marie")
        span.set_attribute("prompt", "Sensitive SMA genetic report")
        span.set_attribute("filename", "MARTIN_Marie_SMA.pdf")
        span.set_attribute("medsyntis.patient_id", "pat_abcdef0123456789")

    spans = exporter.get_finished_spans()
    assert len(spans) == 1
    span_attrs = dict(spans[0].attributes or {})
    assert span_attrs.get("medsyntis.domain") == "sma"
    assert span_attrs.get("medsyntis.patient_id") == "pat_abcdef0123456789"
    assert "first_name" not in span_attrs
    assert "prompt" not in span_attrs
    assert "MARTIN" not in str(span_attrs.get("filename", ""))


def test_stdout_json_and_text_logs_correlate_trace_id_and_span_id():
    """Verify stdout JSON and text loggers automatically inject active trace_id and span_id."""
    exporter = InMemorySpanExporter()
    conf = AppConfig(otel=OTelSettings(sdk_disabled=False, traces_exporter="none"))
    conf.logs.type = "json"
    configure_observability(conf, span_exporter=exporter, force=True)

    logger = conf.set_logger(
        "medsyntis.test.otel", default_context={"domain": "oncology"}
    )
    stream = io.StringIO()
    for handler in logger.handlers:
        if isinstance(handler, logging.StreamHandler):
            handler.stream = stream

    with start_span("medsyntis.log_correlation_check") as span:
        ctx = span.get_span_context()
        expected_trace_id = f"{ctx.trace_id:032x}"
        expected_span_id = f"{ctx.span_id:016x}"
        logger.info("Clinical pipeline step started")

    output = stream.getvalue().strip()
    parsed = json.loads(output)
    assert parsed["trace_id"] == expected_trace_id
    assert parsed["span_id"] == expected_span_id
    assert parsed["message"] == "Clinical pipeline step started"


def test_distributed_trace_propagation_fastapi_to_priority_queue_worker_and_metrics():
    """
    Verify end-to-end W3C traceparent propagation from FastAPI HTTP ingress through
    InMemoryQueueManager enqueue to background worker execution, plus strategic metrics.
    """
    span_exporter = InMemorySpanExporter()
    metric_reader = InMemoryMetricReader()
    conf = AppConfig(otel=OTelSettings(sdk_disabled=False, traces_exporter="none"))
    configure_observability(
        conf,
        span_exporter=span_exporter,
        metric_reader=metric_reader,
        force=True,
    )

    # Custom lightweight executor simulating Wave 1 + Embedding Cache + Manual Edit
    mock_executor = MagicMock()
    embed_backend = MagicMock()
    embed_backend.embed_query.side_effect = lambda q: [0.1, 0.2, 0.3]
    cached_embeddings = CachedEmbeddingsProxy(embed_backend, model_key="bge-m3")

    def _fake_wave1(job: dict[str, Any], lease_id: str, qm: Any) -> str:
        with start_span(
            "medsyntis.extraction.wave_1_identity",
            attributes={"medsyntis.domain": job["domain"], "medsyntis.wave": "wave_1"},
        ):
            cached_embeddings.embed_query("clinical staging query")
            cached_embeddings.embed_query("clinical staging query")  # cache hit
            get_metrics().record_llm_call(
                provider="LiteLLM",
                model="openai/agents",
                operation="chat",
                status="ok",
                duration_ms=42.5,
                input_tokens=120,
                output_tokens=35,
            )
            return "pat_1122334455667788"

    mock_executor.execute_wave1_admin.side_effect = _fake_wave1
    qm = InMemoryQueueManager(
        base_config=conf,
        auto_start_workers=False,
        executor=mock_executor,
    )

    test_app = FastAPI()
    instrument_fastapi_app(test_app)

    @test_app.post("/api/v1/patientmdtforms/upload")
    def _upload_endpoint():
        enq = qm.enqueue_import_file(
            filename="doc_aabbccddeeff0011.pdf",
            include_clinical=False,
            domain="oncology",
        )
        record_manual_edit(
            domain="oncology", section="CancerDescription", action="update"
        )
        return {"queued": len(enq["jobs"])}

    incoming_trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
    incoming_parent_span = "00f067aa0ba902b7"
    incoming_traceparent = f"00-{incoming_trace_id}-{incoming_parent_span}-01"

    client = TestClient(test_app)
    resp = client.post(
        "/api/v1/patientmdtforms/upload",
        headers={
            "traceparent": incoming_traceparent,
            "X-MedSyntis-Domain": "oncology",
        },
    )
    assert resp.status_code == 200
    assert resp.headers.get("X-Trace-Id") == incoming_trace_id

    # Run the queued Wave 1 job synchronously (simulating worker dequeue on separate execution stack)
    assert qm.run_once(domain="oncology") is True
    job = qm.get_queue_jobs(domain="oncology")[0]
    assert job["status"] == JobStatus.COMPLETED.value

    spans = span_exporter.get_finished_spans()
    span_names = {s.name for s in spans}
    assert "POST /api/v1/patientmdtforms/upload" in span_names
    assert "medsyntis.queue.enqueue" in span_names
    assert "medsyntis.queue.process_job" in span_names
    assert "medsyntis.extraction.wave_1_identity" in span_names

    # Every span in the chain must share the exact incoming W3C trace_id!
    for s in spans:
        if s.name in (
            "POST /api/v1/patientmdtforms/upload",
            "medsyntis.queue.enqueue",
            "medsyntis.queue.process_job",
            "medsyntis.extraction.wave_1_identity",
        ):
            assert f"{s.context.trace_id:032x}" == incoming_trace_id

    # Verify strategic metrics were recorded
    metrics_data = metric_reader.get_metrics_data()
    metric_names: set[str] = set()
    for rm in metrics_data.resource_metrics:
        for sm in rm.scope_metrics:
            for m in sm.metrics:
                metric_names.add(m.name)

    expected_metrics = {
        "http.server.duration",
        "medsyntis.queue.enqueued.total",
        "medsyntis.queue.depth",
        "medsyntis.queue.wait_duration_ms",
        "medsyntis.queue.job.duration_ms",
        "medsyntis.queue.jobs.total",
        "medsyntis.manual_edits.total",
        "medsyntis.llm.requests.total",
        "medsyntis.llm.duration_ms",
        "medsyntis.llm.token.usage",
        "medsyntis.embeddings.cache.requests",
    }
    assert expected_metrics.issubset(metric_names)


def test_otlp_http_protobuf_exporter_posts_valid_payload_with_mlflow_headers():
    """Verify official OTLPSpanExporter & OTLPMetricExporter send x-protobuf to MLflow /v1/traces."""
    from http.server import BaseHTTPRequestHandler, HTTPServer
    import threading

    captured_posts: list[dict[str, Any]] = []

    class _CollectorHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length > 0 else b""
            captured_posts.append(
                {
                    "path": self.path,
                    "data": body,
                    "headers": {k.lower(): v for k, v in self.headers.items()},
                }
            )
            self.send_response(200)
            self.end_headers()

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

    server = HTTPServer(("127.0.0.1", 0), _CollectorHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    try:
        headers = parse_otlp_headers("x-mlflow-experiment-id=0")
        span_exporter = OTLPSpanExporter(
            endpoint=f"http://127.0.0.1:{port}/v1/traces",
            headers=headers,
            timeout=5.0,
        )
        metric_exporter = OTLPMetricExporter(
            endpoint=f"http://127.0.0.1:{port}/v1/metrics",
            headers=headers,
            timeout=5.0,
        )
        metric_reader = PeriodicReaderOrManualHelper.build_manual_reader(
            metric_exporter
        )

        conf = AppConfig(
            otel=OTelSettings(
                sdk_disabled=False,
                service_name="medsyntis-api",
                traces_exporter="none",
                metrics_exporter="none",
            )
        )
        configure_observability(
            conf,
            span_exporter=span_exporter,
            metric_reader=metric_reader,
            force=True,
        )

        with start_span(
            "medsyntis.mlflow.smoke", attributes={"medsyntis.domain": "oncology"}
        ):
            get_metrics().record_document_parse(
                domain="oncology", parser="docling", cache_hit=True, duration_ms=12.0
            )

        from opentelemetry import trace as otel_trace

        provider = otel_trace.get_tracer_provider()
        if hasattr(provider, "force_flush"):
            provider.force_flush()
        metric_reader.force_flush()
        reset_observability_for_tests()
    finally:
        server.shutdown()
        server.server_close()

    trace_calls = [c for c in captured_posts if c["path"] == "/v1/traces"]
    metric_calls = [c for c in captured_posts if c["path"] == "/v1/metrics"]

    assert len(trace_calls) >= 1
    assert trace_calls[-1]["headers"].get("content-type") == "application/x-protobuf"
    assert trace_calls[-1]["headers"].get("x-mlflow-experiment-id") == "0"
    assert len(trace_calls[-1]["data"]) > 0

    assert len(metric_calls) >= 1
    assert metric_calls[-1]["headers"].get("content-type") == "application/x-protobuf"
    assert len(metric_calls[-1]["data"]) > 0


class PeriodicReaderOrManualHelper:
    """Helper building an immediate PeriodicExportingMetricReader for deterministic unit tests."""

    @staticmethod
    def build_manual_reader(exporter: Any) -> Any:
        from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader

        return PeriodicExportingMetricReader(exporter, export_interval_millis=600_000)


def test_w3c_carrier_inject_and_extract_roundtrip():
    """Verify inject_trace_context and extract_trace_context roundtrip W3C traceparent."""
    exporter = InMemorySpanExporter()
    conf = AppConfig(otel=OTelSettings(sdk_disabled=False, traces_exporter="none"))
    configure_observability(conf, span_exporter=exporter, force=True)

    carrier: dict[str, str] = {}
    with start_span("parent-op") as parent:
        expected_tid = f"{parent.get_span_context().trace_id:032x}"
        inject_trace_context(carrier)

    assert "traceparent" in carrier
    assert expected_tid in carrier["traceparent"]

    restored_ctx = extract_trace_context(carrier)
    with start_span("child-op", context=restored_ctx) as child:
        assert f"{child.get_span_context().trace_id:032x}" == expected_tid


def test_prod_docker_compose_and_makefile_define_optional_mlflow_profile():
    """Verify mlflow is optional (--profile mlflow), hardened, loopback-bound, and off by default."""
    compose_path = REPO_ROOT / "dist/docker/compose/docker-compose.prod.yml"
    compose_raw = compose_path.read_text(encoding="utf-8")
    compose_data = yaml.safe_load(compose_raw)

    services = compose_data.get("services", {})
    assert "mlflow" in services, (
        "Optional mlflow service must exist in docker-compose.prod.yml"
    )
    mlflow_svc = services["mlflow"]

    assert mlflow_svc.get("profiles") == ["mlflow"]
    assert ":" in mlflow_svc["image"] and not mlflow_svc["image"].endswith(":latest")
    assert "ALL" in mlflow_svc.get("cap_drop", [])
    assert "no-new-privileges:true" in mlflow_svc.get("security_opt", [])
    ports = mlflow_svc.get("ports", [])
    assert any(str(p).startswith("127.0.0.1:") for p in ports)
    assert "backend_internal" in mlflow_svc.get("networks", [])

    # Verify OTEL_SDK_DISABLED defaults to true in medsyntis-api and medsyntis-web
    api_env = services["medsyntis-api"]["environment"]
    web_env = services["medsyntis-web"]["environment"]
    assert "OTEL_SDK_DISABLED" in api_env
    assert "true" in str(api_env["OTEL_SDK_DISABLED"])
    assert "OTEL_SDK_DISABLED" in web_env
    assert "true" in str(web_env["OTEL_SDK_DISABLED"])

    makefile_raw = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")
    assert "start-prod-mlflow:" in makefile_raw
    assert "--profile mlflow" in makefile_raw
