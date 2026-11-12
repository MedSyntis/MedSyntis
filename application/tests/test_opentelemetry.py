"""
TDD test suite for End-to-End OpenTelemetry Observability (MedSyntis#14).

Covers:
1. Official `OTEL_*` environment variables (`OTelSettings`) and safe defaults (`OTEL_SDK_DISABLED=true`, stdout logs, No-Op tracing/metrics).
2. Local sovereignty guardrail (`APP_ALLOW_REMOTE_LLM=false` blocks non-local OTLP endpoints while allowing local Docker services like `http://grafana:4318`).
3. Zero-PHI span & metric attribute sanitization (`SanitizingSpanProcessor` + `sanitize_otel_attributes`).
4. Automatic `trace_id` and `span_id` correlation in text and JSON `stdout` logs when a span is recording.
5. End-to-end W3C `traceparent` propagation: FastAPI HTTP ingress -> `InMemoryQueueManager` enqueue -> worker execution (Wave 1/2/3) -> DocumentReader / CachedEmbeddingsProxy / MedSyntisAgent / MongoDB.
6. Pertinent clinical & operational OpenTelemetry metrics (`Counter` & `Histogram` instruments), including `medsyntis.manual_edits.total`.
7. Official OTLP HTTP/Protobuf exporter (`application/x-protobuf` + `OTEL_EXPORTER_OTLP_HEADERS` for `/v1/traces` and `/v1/metrics`).
8. Optional hardened `grafana` (`grafana/otel-lgtm`) service (`--profile grafana`) in `dist/docker/compose/docker-compose.prod.yml` and `start-prod-grafana` in `Makefile`.
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
from opentelemetry.exporter.otlp.proto.http._log_exporter import OTLPLogExporter
from opentelemetry.sdk._logs.export import InMemoryLogRecordExporter
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
import pytest
import yaml

from src.application.config import AppConfig, OTelSettings
from src.infrastructure.llm.base import CachedEmbeddingsProxy
from src.infrastructure.observability.otel import (
    _build_official_log_exporter,
    _build_official_metric_reader,
    _build_official_span_exporter,
    _build_sampler,
    attach_otel_handler_to_uvicorn_loggers,
    configure_observability,
    extract_trace_context,
    get_meter,
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
        "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
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
    monkeypatch.setenv("OTEL_METRICS_EXPORTER", "otlp")
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://grafana:4318")
    monkeypatch.setenv(
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "http://grafana:4318/v1/traces"
    )
    monkeypatch.setenv(
        "OTEL_EXPORTER_OTLP_HEADERS",
        "X-Scope-OrgID=medsyntis,Authorization=Bearer%20tok",
    )
    monkeypatch.setenv("OTEL_TRACES_SAMPLER_ARG", "0.5")

    conf = AppConfig()
    assert conf.otel.sdk_disabled is False
    assert conf.otel.service_name == "medsyntis-api-prod"
    assert conf.otel.traces_exporter == "otlp"
    assert conf.otel.metrics_exporter == "otlp"
    assert conf.otel.exporter_otlp_endpoint == "http://grafana:4318"
    assert conf.otel.exporter_otlp_traces_endpoint == "http://grafana:4318/v1/traces"
    assert conf.otel.traces_sampler_arg == pytest.approx(0.5)
    assert parse_otlp_headers(conf.otel.exporter_otlp_headers) == {
        "X-Scope-OrgID": "medsyntis",
        "Authorization": "Bearer tok",
    }

    sma_conf = conf.for_domain("sma")
    assert sma_conf.otel.sdk_disabled is False
    assert sma_conf.otel.exporter_otlp_endpoint == "http://grafana:4318"
    assert (
        sma_conf.otel.exporter_otlp_traces_endpoint == "http://grafana:4318/v1/traces"
    )


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

    # Local Docker service (`grafana`) and loopback (`127.0.0.1`) must pass
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://grafana:4318")
    valid_conf = AppConfig()
    assert valid_conf.otel.exporter_otlp_endpoint == "http://grafana:4318"


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


def test_otlp_http_protobuf_exporter_posts_valid_payload_to_grafana_otlp():
    """Verify official OTLP HTTP/Protobuf exporters send traces, metrics, and Zero-PHI logs to /v1/traces, /v1/metrics, /v1/logs."""
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
        conf = AppConfig(
            otel=OTelSettings(
                sdk_disabled=False,
                service_name="medsyntis-api",
                traces_exporter="otlp",
                metrics_exporter="otlp",
                logs_exporter="otlp",
                exporter_otlp_endpoint=f"http://127.0.0.1:{port}",
                exporter_otlp_headers="X-Scope-OrgID=medsyntis",
                exporter_otlp_timeout=5_000,
                metric_export_interval=60_000,
            )
        )
        configure_observability(conf, force=True)
        api_logger = conf.set_logger("medsyntis.api.otlp_smoke")

        with start_span(
            "medsyntis.grafana.smoke", attributes={"medsyntis.domain": "oncology"}
        ):
            api_logger.info(
                "Grafana Loki OTLP smoke log",
                extra={"first_name": "Jean", "medsyntis.domain": "oncology"},
            )
            get_metrics().record_document_parse(
                domain="oncology", parser="docling", cache_hit=True, duration_ms=12.0
            )
            get_metrics().record_extraction_section(
                domain="oncology",
                wave="wave_2",
                section="CancerDescription",
                status="ok",
                duration_ms=25.0,
            )
            get_metrics().record_vectordb_op(
                backend="milvus",
                operation="similarity_search",
                domain="oncology",
                duration_ms=8.5,
            )

        # Shutdown flushes TracerProvider, MeterProvider, and LoggerProvider batches cleanly
        reset_observability_for_tests()
    finally:
        server.shutdown()
        server.server_close()

    trace_calls = [c for c in captured_posts if c["path"] == "/v1/traces"]
    metric_calls = [c for c in captured_posts if c["path"] == "/v1/metrics"]
    log_calls = [c for c in captured_posts if c["path"] == "/v1/logs"]

    assert len(trace_calls) >= 1
    assert trace_calls[-1]["headers"].get("content-type") == "application/x-protobuf"
    assert trace_calls[-1]["headers"].get("x-scope-orgid") == "medsyntis"
    assert len(trace_calls[-1]["data"]) > 0

    assert len(metric_calls) >= 1
    assert metric_calls[-1]["headers"].get("content-type") == "application/x-protobuf"
    assert len(metric_calls[-1]["data"]) > 0

    assert len(log_calls) >= 1
    assert log_calls[-1]["headers"].get("content-type") == "application/x-protobuf"
    assert log_calls[-1]["headers"].get("x-scope-orgid") == "medsyntis"
    assert b"Grafana Loki OTLP smoke log" in log_calls[-1]["data"]
    assert b"Jean" not in log_calls[-1]["data"]


def test_otlp_logs_sanitizer_uvicorn_bridge_and_dotenv_loading(tmp_path: Path):
    """Verify SanitizingLogRecordProcessor, Uvicorn handler attachment (/health filtered), and .env loading."""
    dotenv_file = tmp_path / ".env"
    dotenv_file.write_text(
        "OTEL_SDK_DISABLED=false\n"
        "OTEL_SERVICE_NAME=medsyntis-api-dotenv\n"
        "OTEL_TRACES_EXPORTER=otlp\n"
        "OTEL_LOGS_EXPORTER=otlp\n"
        "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318\n",
        encoding="utf-8",
    )
    loaded_otel = OTelSettings(_env_file=dotenv_file)
    assert loaded_otel.sdk_disabled is False
    assert loaded_otel.service_name == "medsyntis-api-dotenv"
    assert loaded_otel.logs_exporter == "otlp"

    log_exporter = InMemoryLogRecordExporter()
    span_exporter = InMemorySpanExporter()
    conf = AppConfig(
        otel=OTelSettings(
            sdk_disabled=False,
            traces_exporter="none",
            metrics_exporter="none",
            logs_exporter="none",
            resource_attributes="service.name=medsyntis-custom",
        )
    )
    configure_observability(
        conf,
        span_exporter=span_exporter,
        log_exporter=log_exporter,
        force=True,
    )

    uv_access = logging.getLogger("uvicorn.access")
    prev_propagate = uv_access.propagate
    prev_level = uv_access.level
    uv_access.propagate = False
    uv_access.setLevel(logging.INFO)
    try:
        attach_otel_handler_to_uvicorn_loggers()
        uv_access.info('127.0.0.1:50000 - "GET /health HTTP/1.1" 200')
        uv_access.info('127.0.0.1:50000 - "GET /api/v1/patients HTTP/1.1" 200')

        app_logger = conf.set_logger("medsyntis.test.logs")
        app_logger.warning(
            "Queue retry scheduled",
            extra={
                "first_name": "Claire",
                "prompt": "Secret clinical prompt",
                "patient_id": "DUPONT_1950",
                "document": "DUPONT_Claire.pdf",
                "medsyntis.domain": "sma",
            },
        )
    finally:
        uv_access.propagate = prev_propagate
        uv_access.setLevel(prev_level)

    finished_logs = log_exporter.get_finished_logs()
    bodies = [str(lr.log_record.body) for lr in finished_logs]
    assert not any("/health" in b for b in bodies)
    assert any("/api/v1/patients" in b for b in bodies)
    assert any("Queue retry scheduled" in b for b in bodies)

    retry_rec = next(
        lr for lr in finished_logs if "Queue retry scheduled" in str(lr.log_record.body)
    )
    attrs = dict(retry_rec.log_record.attributes or {})
    assert attrs.get("medsyntis.domain") == "sma"
    assert attrs.get("patient_id") == "[REDACTED]"
    assert str(attrs.get("document", "")).startswith("sha256:")
    assert "first_name" not in attrs
    assert "prompt" not in attrs


def test_exporters_samplers_and_error_span_recording():
    """Cover sampler strategies, console/grpc/unsupported exporter builders, and span exception status."""
    for sampler_name in (
        "always_on",
        "always_off",
        "traceidratio",
        "parentbased_always_on",
        "parentbased_always_off",
        "parentbased_traceidratio",
    ):
        assert _build_sampler(sampler_name, 0.25) is not None

    console_cfg = OTelSettings(
        sdk_disabled=False,
        traces_exporter="console",
        metrics_exporter="console",
        logs_exporter="console",
        metric_export_interval=5_000,
    )
    assert _build_official_span_exporter(console_cfg) is not None
    reader = _build_official_metric_reader(console_cfg)
    assert reader is not None
    reader.shutdown()
    assert _build_official_log_exporter(console_cfg) is not None

    grpc_cfg = OTelSettings(
        sdk_disabled=False,
        traces_exporter="otlp",
        metrics_exporter="otlp",
        logs_exporter="otlp",
        exporter_otlp_protocol="grpc",
        exporter_otlp_endpoint="http://127.0.0.1:4317",
        exporter_otlp_headers="x-org=medsyntis",
    )
    assert _build_official_span_exporter(grpc_cfg) is not None
    grpc_reader = _build_official_metric_reader(grpc_cfg)
    assert grpc_reader is not None
    grpc_reader.shutdown()
    assert _build_official_log_exporter(grpc_cfg) is not None

    invalid_cfg = OTelSettings(
        sdk_disabled=False,
        traces_exporter="unknown_exp",
        metrics_exporter="unknown_exp",
        logs_exporter="unknown_exp",
    )
    assert _build_official_span_exporter(invalid_cfg) is None
    assert _build_official_metric_reader(invalid_cfg) is None
    assert _build_official_log_exporter(invalid_cfg) is None
    assert isinstance(
        OTLPLogExporter(endpoint="http://127.0.0.1:4318/v1/logs"), OTLPLogExporter
    )

    span_exporter = InMemorySpanExporter()
    conf = AppConfig(otel=OTelSettings(sdk_disabled=False, traces_exporter="none"))
    configure_observability(conf, span_exporter=span_exporter, force=True)
    assert get_meter("medsyntis.test") is not None

    with pytest.raises(RuntimeError, match="boom"):
        with start_span("failing-op", attributes={"tags": ["a", 1]}):
            raise RuntimeError("boom")

    spans = span_exporter.get_finished_spans()
    assert len(spans) == 1
    assert spans[0].attributes.get("error.type") == "RuntimeError"


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


def test_prod_docker_compose_and_makefile_define_optional_grafana_profile():
    """Verify grafana (otel-lgtm) is optional (--profile grafana), hardened, loopback-bound, and off by default."""
    compose_path = REPO_ROOT / "dist/docker/compose/docker-compose.prod.yml"
    compose_raw = compose_path.read_text(encoding="utf-8")
    compose_data = yaml.safe_load(compose_raw)

    services = compose_data.get("services", {})
    assert "mlflow" not in services
    assert "grafana" in services, (
        "Optional grafana service must exist in docker-compose.prod.yml"
    )
    grafana_svc = services["grafana"]

    assert grafana_svc.get("profiles") == ["grafana"]
    assert "grafana/otel-lgtm:" in grafana_svc["image"]
    assert not grafana_svc["image"].endswith(":latest")
    assert "ALL" in grafana_svc.get("cap_drop", [])
    assert "no-new-privileges:true" in grafana_svc.get("security_opt", [])
    ports = grafana_svc.get("ports", [])
    assert any(str(p).startswith("127.0.0.1:") for p in ports)
    assert "backend_internal" in grafana_svc.get("networks", [])

    # Verify OTEL_* keys are declared explicitly in both medsyntis-api and medsyntis-web (no podman-compose YAML anchor drop)
    api_env = services["medsyntis-api"]["environment"]
    web_env = services["medsyntis-web"]["environment"]
    for required_otel_key in (
        "OTEL_SDK_DISABLED",
        "OTEL_SERVICE_NAME",
        "OTEL_TRACES_EXPORTER",
        "OTEL_METRICS_EXPORTER",
        "OTEL_LOGS_EXPORTER",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    ):
        assert required_otel_key in api_env
        assert required_otel_key in web_env
    assert "true" in str(api_env["OTEL_SDK_DISABLED"])
    assert "true" in str(web_env["OTEL_SDK_DISABLED"])

    makefile_raw = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")
    assert "start-prod-mlflow" not in makefile_raw
    assert "start-prod-grafana:" in makefile_raw
    assert "restart-prod-grafana:" in makefile_raw
    assert "start-web-grafana:" in makefile_raw
    assert "OTEL_LOGS_EXPORTER" in makefile_raw
    assert "--force-recreate" in makefile_raw
    assert "--profile grafana" in makefile_raw
    assert "http://grafana:4318" in makefile_raw


def test_langchain_auto_instrumentor_emits_zero_phi_medsyntis_ai_spans():
    """
    Verify official `opentelemetry-instrumentation-genai-langchain` (`LangChainInstrumentor`)
    automatically traces `create_agent`, `BaseChatModel`, and `@tool` executions under the
    dedicated `medsyntis-ai` service resource with Zero-PHI enforcement and shared W3C `trace_id`.
    """
    from unittest.mock import patch

    from langchain.agents import create_agent
    from langchain.tools import tool
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, BaseMessage, HumanMessage
    from langchain_core.outputs import ChatGeneration, ChatResult

    from src.application.agent.agent import ChatResponse as AgentChatResponse
    from src.application.agent.agent import MedSyntisAgent
    from src.infrastructure.observability import start_ai_span

    class _MockLocalChatModel(BaseChatModel):
        model_name: str = "Ornith-1.5-35B-A3B-IQ4_XS"
        turn: int = 0

        @property
        def _llm_type(self) -> str:
            return "litellm"

        @property
        def _identifying_params(self) -> dict[str, Any]:
            return {"model_name": self.model_name, "temperature": 0.1}

        def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
            return self

        def _generate(
            self,
            messages: list[BaseMessage],
            stop: list[str] | None = None,
            run_manager: Any = None,
            **kwargs: Any,
        ) -> ChatResult:
            self.turn += 1
            if self.turn == 1:
                msg = AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "lookup_guideline",
                            "args": {"query": "Jean DUPONT colon stage III"},
                            "id": "call_1",
                        }
                    ],
                    usage_metadata={
                        "input_tokens": 310,
                        "output_tokens": 28,
                        "total_tokens": 338,
                    },
                    response_metadata={
                        "finish_reason": "tool_calls",
                        "model_name": self.model_name,
                    },
                )
            else:
                msg = AIMessage(
                    content='{"response": "Synthèse validée pour Jean DUPONT"}',
                    usage_metadata={
                        "input_tokens": 420,
                        "output_tokens": 52,
                        "total_tokens": 472,
                    },
                    response_metadata={
                        "finish_reason": "stop",
                        "model_name": self.model_name,
                    },
                )
            return ChatResult(generations=[ChatGeneration(message=msg)])

    embed_backend = MagicMock()
    embed_backend.embed_documents.return_value = [[0.1, 0.2], [0.3, 0.4]]
    embed_backend.embed_query.return_value = [0.5, 0.6]
    proxy = CachedEmbeddingsProxy(embed_backend, model_key="bge-m3")

    @tool
    def lookup_guideline(query: str) -> str:
        """Search local TNCD guideline chunks."""
        proxy.embed_documents(["guideline chunk 1", "guideline chunk 2"])
        proxy.embed_query(query)
        return "Secret clinical chunk mentioning Jean DUPONT"

    span_exporter = InMemorySpanExporter()
    metric_reader = InMemoryMetricReader()
    conf = AppConfig(
        otel=OTelSettings(
            sdk_disabled=False,
            service_name="medsyntis-api",
            traces_exporter="none",
        )
    )
    configure_observability(
        conf,
        span_exporter=span_exporter,
        metric_reader=metric_reader,
        force=True,
    )

    with start_span("POST /api/v1/patientmdtform/chat") as root_span:
        root_tid = f"{root_span.get_span_context().trace_id:032x}"

        # 1. Real LangChain `create_agent` + `@tool` + `BaseChatModel` auto-instrumented end-to-end
        real_graph = create_agent(
            model=_MockLocalChatModel(),
            tools=[lookup_guideline],
            name="Gastroenterologist",
        )
        graph_out = real_graph.invoke(
            {
                "messages": [
                    HumanMessage(
                        content="Patient Jean DUPONT né le 12/05/1960 : quel bilan TNCD ?"
                    )
                ]
            }
        )
        assert "messages" in graph_out

        # 2. Error recording branch on start_ai_span + MedSyntisAgent retry path
        with pytest.raises(RuntimeError):
            with start_ai_span(
                "embeddings bge-m3",
                attributes={"gen_ai.prompt.variable.secret": "Jean DUPONT"},
            ):
                raise RuntimeError("embedding server unreachable")

        with (
            patch("src.application.agent.agent.get_llm_client") as mock_get_llm,
            patch("src.application.agent.agent.create_agent") as mock_create_agent,
        ):
            mock_llm_client = MagicMock()
            mock_llm_client.chat.return_value = MagicMock()
            mock_get_llm.return_value = mock_llm_client

            mock_graph = MagicMock()
            final_msg = AIMessage(
                content='{"response": "Synthèse validée"}',
                response_metadata={
                    "token_usage": {"prompt_tokens": 400, "completion_tokens": 60}
                },
            )
            mock_graph.invoke.side_effect = [
                RuntimeError("transient socket error"),
                {"messages": [HumanMessage(content="q"), final_msg]},
            ]
            mock_create_agent.return_value = mock_graph

            agent = MedSyntisAgent(config=conf, output_format=AgentChatResponse)
            ans = agent.ask("Question clinique Jean DUPONT", retry=2)
            assert ans.response == "Synthèse validée"

    spans = span_exporter.get_finished_spans()
    ai_spans = [
        s for s in spans if s.resource.attributes.get("service.name") == "medsyntis-ai"
    ]
    api_spans = [
        s for s in spans if s.resource.attributes.get("service.name") == "medsyntis-api"
    ]

    assert len(api_spans) >= 1
    assert len(ai_spans) >= 5

    ai_names = {s.name for s in ai_spans}
    assert any(n.startswith("invoke_agent") for n in ai_names)
    assert any("Ornith-1.5-35B-A3B-IQ4_XS" in n for n in ai_names)
    assert "execute_tool lookup_guideline" in ai_names
    assert "embeddings bge-m3" in ai_names

    # Every AI span must share the parent FastAPI W3C trace_id and scrub 100% of PHI/prompts/args
    for s in ai_spans:
        assert f"{s.context.trace_id:032x}" == root_tid
        serialized_attrs = json.dumps(dict(s.attributes or {}))
        assert "DUPONT" not in serialized_attrs
        assert "12/05/1960" not in serialized_attrs
        assert "gen_ai.input.messages" not in (s.attributes or {})
        assert "gen_ai.output.messages" not in (s.attributes or {})
        assert "gen_ai.tool.call.arguments" not in (s.attributes or {})
        assert "gen_ai.tool.call.result" not in (s.attributes or {})

    chat_spans = [s for s in ai_spans if "Ornith-1.5-35B-A3B-IQ4_XS" in s.name]
    assert len(chat_spans) == 2
    assert chat_spans[0].attributes.get("gen_ai.usage.input_tokens") == 310
    assert chat_spans[0].attributes.get("gen_ai.usage.output_tokens") == 28

    # Verify token extraction helper covers both usage_metadata and response_metadata
    m1 = AIMessage(
        content="a",
        usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
    )
    m2 = AIMessage(
        content="b",
        response_metadata={
            "token_usage": {"prompt_tokens": 20, "completion_tokens": 7}
        },
    )
    assert MedSyntisAgent._extract_token_usage([m1, m2]) == (30, 12)


def test_otel_disabled_noop_metrics_processors_and_queue_gauge_branches(
    monkeypatch: pytest.MonkeyPatch,
):
    """Cover disabled MedSyntisMetrics no-op paths, processor edge cases, and live queue depth gauge."""
    from types import SimpleNamespace

    import src.infrastructure.queue.memory_queue as mq_mod
    from src.infrastructure.observability.otel import (
        SanitizingLogRecordProcessor,
        SanitizingSpanProcessor,
        _fastapi_client_response_hook,
        _fastapi_server_request_hook,
        _observe_queue_depth,
        is_observability_enabled,
    )

    reset_observability_for_tests()
    assert is_observability_enabled() is False

    # Disabled metrics facade must safely no-op on every instrument
    disabled_metrics = get_metrics()
    assert disabled_metrics.enabled is False
    disabled_metrics.record_queue_enqueue(domain="oncology", job_type="WAVE1_ADMIN")
    disabled_metrics.record_queue_job(
        domain="oncology",
        job_type="WAVE1_ADMIN",
        status="completed",
        wait_ms=1.0,
        duration_ms=2.0,
    )
    disabled_metrics.record_extraction_section(
        domain="oncology",
        wave="wave_2",
        section="CancerDescription",
        status="ok",
        duration_ms=5.0,
    )
    disabled_metrics.record_manual_edit(
        domain="oncology", section="CancerDescription", action="update"
    )
    disabled_metrics.record_llm_call(
        provider="litellm",
        model="openai/agents",
        operation="chat",
        status="ok",
        duration_ms=10.0,
        input_tokens=5,
        output_tokens=5,
    )
    disabled_metrics.record_embedding_cache(model="bge-m3", hit=True)
    disabled_metrics.record_document_parse(
        domain="oncology", parser="docling", cache_hit=False, duration_ms=15.0
    )
    disabled_metrics.record_vectordb_op(
        backend="milvus", operation="search", domain="oncology", duration_ms=3.0
    )

    assert inject_trace_context({"existing": "1"}) == {"existing": "1"}
    assert (
        extract_trace_context(
            {"traceparent": "00-11111111111111111111111111111111-2222222222222222-01"}
        )
        is None
    )

    # Processor edge branches (lock=None, force_flush, Mapping/long log body)
    sp = SanitizingSpanProcessor()
    lockless_span = SimpleNamespace(
        _attributes={"first_name": "Jean", "medsyntis.domain": "oncology"},
        _lock=None,
    )
    sp.on_end(lockless_span)  # type: ignore[arg-type]
    assert "first_name" not in dict(lockless_span._attributes)
    assert sp.force_flush() is True
    assert sp.shutdown() is None

    lp = SanitizingLogRecordProcessor()
    lp.on_emit(SimpleNamespace(log_record=None))  # type: ignore[arg-type]
    long_rec = SimpleNamespace(
        log_record=SimpleNamespace(attributes=None, body="x" * 3000)
    )
    lp.on_emit(long_rec)  # type: ignore[arg-type]
    assert len(long_rec.log_record.body) == 2048
    dict_rec = SimpleNamespace(
        log_record=SimpleNamespace(
            attributes=None,
            body={"first_name": "Jean", "medsyntis.domain": "sma"},
        )
    )
    lp.on_emit(dict_rec)  # type: ignore[arg-type]
    assert dict_rec.log_record.body == {"medsyntis.domain": "sma"}
    assert lp.force_flush() is True
    assert lp.shutdown() is None

    # Live queue depth callback with active _GLOBAL_MANAGER
    fake_mgr = MagicMock()
    fake_mgr.get_queue_stats.return_value = {
        "pending": 2,
        "processing": 1,
        "active_locks": 1,
    }
    monkeypatch.setattr(mq_mod, "_GLOBAL_MANAGER", fake_mgr)
    obs = list(_observe_queue_depth(MagicMock()))
    assert [(o.value, o.attributes["state"]) for o in obs] == [
        (2, "pending"),
        (1, "processing"),
        (1, "active_leases"),
    ]

    # Configure idempotency (force=False) and extract_trace_context without traceparent
    conf = AppConfig(otel=OTelSettings(sdk_disabled=False, traces_exporter="none"))
    configure_observability(conf, force=True)
    configure_observability(conf, force=False)
    assert extract_trace_context({}) is None
    assert extract_trace_context({"x-other": "val"}) is None
    _fastapi_server_request_hook(None, {})
    _fastapi_client_response_hook(None, {}, {"type": "http.response.body"})
