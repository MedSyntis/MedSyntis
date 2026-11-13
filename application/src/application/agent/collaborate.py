from collections import OrderedDict
import json
import gc
import threading

from typing import Any
from pydantic import BaseModel


from src.application.config import AppConfig

# Legacy import to support existing patch-based unit tests
from src.application.reader import DocumentReader
from src.application.agent.agent import MedSyntisAgent, DebateTurn
from src.domain.agents import Agents, get_domain_agents_cls

_DEBATE_CACHE_MAXSIZE: int = 32
_DEBATE_CACHE_LOCK = threading.Lock()
_DEBATE_ROUND_CACHE: OrderedDict[tuple[Any, ...], dict[str, dict[str, str]]] = (
    OrderedDict()
)


def clear_debate_checkpoint_cache() -> None:
    """Clear all cached intermediate Round 1 & Round 2 collaborative debate opinions."""
    with _DEBATE_CACHE_LOCK:
        _DEBATE_ROUND_CACHE.clear()


def _build_debate_checkpoint_key(
    mtd: Any,
    output_format: Any,
    question: str | None,
    agents_classes: list[type[MedSyntisAgent]],
    ressources: list[str] | None = None,
) -> tuple[Any, ...] | None:
    doc_name = getattr(mtd, "document", None) if mtd is not None else None
    if not isinstance(doc_name, str) or not doc_name.strip():
        return None
    raw_hash = getattr(mtd, "file_hash", None)
    file_hash = raw_hash if isinstance(raw_hash, str) and raw_hash else ""
    format_name = getattr(output_format, "__name__", str(output_format))
    agent_ids = tuple(
        str(getattr(cls, "agent_name", None) or getattr(cls, "__name__", str(cls)))
        for cls in agents_classes
    )
    res_key = tuple(ressources) if ressources is not None else None
    return (
        doc_name.strip(),
        file_hash,
        format_name,
        question or "",
        agent_ids,
        res_key,
    )


def _get_debate_checkpoint(
    key: tuple[Any, ...] | None,
) -> dict[str, dict[str, str]] | None:
    if key is None:
        return None
    with _DEBATE_CACHE_LOCK:
        entry = _DEBATE_ROUND_CACHE.get(key)
        if entry is None:
            return None
        _DEBATE_ROUND_CACHE.move_to_end(key)
        return {k: dict(v) for k, v in entry.items() if isinstance(v, dict)}


def _save_debate_checkpoint(
    key: tuple[Any, ...] | None,
    stage: str,
    stage_opinions: dict[str, str],
) -> None:
    if key is None or not stage_opinions:
        return
    with _DEBATE_CACHE_LOCK:
        entry = _DEBATE_ROUND_CACHE.get(key)
        if entry is None:
            entry = {}
            _DEBATE_ROUND_CACHE[key] = entry
        entry[stage] = dict(stage_opinions)
        _DEBATE_ROUND_CACHE.move_to_end(key)
        while len(_DEBATE_ROUND_CACHE) > _DEBATE_CACHE_MAXSIZE:
            _DEBATE_ROUND_CACHE.popitem(last=False)


def _evict_debate_checkpoint(key: tuple[Any, ...] | None) -> None:
    if key is None:
        return
    with _DEBATE_CACHE_LOCK:
        _DEBATE_ROUND_CACHE.pop(key, None)


def collaborative_debate(
    agents_classes: list[type[MedSyntisAgent]],
    question: str | None,
    output_format: type[BaseModel],
    config: AppConfig,
    mtd: DocumentReader,
    logger: Any,
    coordinator_agent_cls: type["MedSyntisAgent"] | None = None,
    callbacks: list | None = None,
    ressources: list[str] | None = None,
) -> dict:
    if coordinator_agent_cls is None:
        domain = config.domain
        if isinstance(Agents.Coordinator_agent, type) and isinstance(domain, str):
            coordinator_agent_cls = get_domain_agents_cls(domain).Coordinator_agent
        else:
            coordinator_agent_cls = Agents.Coordinator_agent
    logger.info("Running collaborative debate mode...")

    checkpoint_key = _build_debate_checkpoint_key(
        mtd=mtd,
        output_format=output_format,
        question=question,
        agents_classes=agents_classes,
        ressources=ressources,
    )
    checkpoint = _get_debate_checkpoint(checkpoint_key) or {}
    cached_round1 = checkpoint.get("round1")
    cached_round2 = checkpoint.get("round2")

    if cached_round1 and cached_round2:
        logger.info(
            "Debate checkpoint HIT: reusing cached Round 1 and Round 2 expert opinions."
        )
        opinions = dict(cached_round1)
        updated_opinions = dict(cached_round2)
    else:
        # Step 0 : init agents, name them and assign resources to them
        agents = []
        for magent in agents_classes:
            if ressources is not None:
                a = magent(
                    config=config,
                    mtd=mtd,
                    output_format=DebateTurn,
                    ressources=ressources,
                )
            else:
                a = magent(
                    config=config,
                    mtd=mtd,
                    output_format=DebateTurn,
                )
            agents.append(a)

        # Step 1: Initial Turn (Parallel Reasoning with DebateTurn format)
        if cached_round1:
            logger.info(
                "Debate checkpoint HIT: reusing cached Round 1 expert opinions."
            )
            opinions = dict(cached_round1)
            round1_all_ok = True
        else:
            opinions = {}
            round1_all_ok = True
            for magent in agents:
                logger.info(
                    f"Debate: Requesting initial analysis from {magent.agent_name}..."
                )

                opinion_prompt = (
                    f"Answer in {magent.response_language.capitalize()} language, not mention it in the answer.\n"
                    f"As an expert in {magent.expert_type if hasattr(magent, 'expert_type') else magent.agent_name}, "
                    f"analyze the patient file and provide your initial arguments regarding the following question:\n{question}\n"
                    "Use Markdown formatting inside your `response` field (`**bold**` for key clinical arguments/guidelines, bullet points `- `, and concise sub-sections)."
                )
                try:
                    res = magent.ask(opinion_prompt, DebateTurn, callbacks=callbacks)
                    if res and getattr(res, "response", None):
                        opinions[magent.agent_name] = res.response
                except Exception as e:
                    round1_all_ok = False
                    logger.error(
                        "Error getting Round 1 opinion from %s (skipping failed expert): %s",
                        magent.agent_name,
                        MedSyntisAgent._summarize_validation_error(e),
                    )

            if not opinions:
                raise RuntimeError(
                    "All specialist agents failed during Round 1 of collaborative debate."
                )

            if round1_all_ok and opinions:
                _save_debate_checkpoint(checkpoint_key, "round1", opinions)

        # Step 2: Cross-Review & Debate Turn (only for experts with valid Round 1 opinions)
        compiled_opinions = "\n".join(
            f"- **{name}** : {text}" for name, text in opinions.items()
        )

        updated_opinions = {}
        round2_all_ok = round1_all_ok
        for magent in agents:
            if magent.agent_name not in opinions:
                continue
            logger.info(f"Debate: Requesting cross-review from {magent.agent_name}...")

            debate_prompt = (
                f"Answer in {magent.response_language.capitalize()} language, not mention it in the answer.\n"
                f"We are conducting a multidisciplinary team (MDT/RCP) debate. Here are the initial opinions and arguments from all participating experts:\n\n"
                f"{compiled_opinions}\n\n"
                f"The overall question is: {question}\n\n"
                f"Please review the opinions of the other experts. Provide your final refined clinical assessment, addressing points of agreement or disagreement, to help prepare a pre-MDT synthesis for collegial review. "
                "Use Markdown formatting inside your `response` field (`**bold**` for key clinical arguments/guidelines, bullet points `- `, and concise sub-sections)."
            )
            try:
                res = magent.ask(debate_prompt, DebateTurn, callbacks=callbacks)
                updated_opinions[magent.agent_name] = res.response
            except Exception as e:
                round2_all_ok = False
                logger.error(
                    "Error getting Round 2 opinion from %s: %s",
                    magent.agent_name,
                    MedSyntisAgent._summarize_validation_error(e),
                )
                if magent.agent_name in opinions:
                    updated_opinions[magent.agent_name] = opinions[magent.agent_name]

        if round2_all_ok and updated_opinions:
            _save_debate_checkpoint(checkpoint_key, "round2", updated_opinions)

        for a in agents:
            del a
        del agents
        gc.collect()

    # Step 3: Synthesis & Final Structured Pre-MDT Synthesis
    final_compiled_opinions = "\n".join(
        f"- **{name}** : {text}" for name, text in updated_opinions.items()
    )

    prefetched_md = MedSyntisAgent._extract_prefetched_mtd_markdown(mtd=mtd)
    coordinator = coordinator_agent_cls(
        config=config,
        mtd=None,
        output_format=output_format,
        reasoning=False,
        prefetched_markdown=prefetched_md,
    )
    logger.info(
        f"Debate: Synthesizing final structured pre-MDT synthesis using {coordinator.agent_name}..."
    )

    synthesis_prompt = (
        f"Answer in {coordinator.response_language.capitalize()} language, not mention it in the answer.\n"
        f"You are the coordinator of the multidisciplinary team (MDT/RCP). The experts have completed their debate. "
        f"Here is the summary of their final opinions:\n\n"
        f"{final_compiled_opinions}\n\n"
        f"The overall question is: {question}\n\n"
        f"Based on the opinions of the experts and grounded in the pre-loaded patient record context (if provided), synthesize the discussion, reconcile disagreements into a pre-MDT synthesis for collegial review, and fill out the expected structured response format. "
        f"Use Markdown formatting (`**bold**` for key clinical arguments/guidelines, bullet points `- `, and concise sub-sections) in free-text fields such as `reflection`, `what_missing`, `proposed_care_type`, and `clinical_rationale` (while keeping `Reference.name` and enum fields as plain strings). "
        f"Do not fabricate or hallucinate any clinical facts not grounded in the patient record or expert opinions."
    )

    try:
        datas = json.loads(
            coordinator.ask(
                synthesis_prompt, output_format, callbacks=callbacks
            ).model_dump_json()
        )
        if isinstance(datas, dict):
            datas["reasoning_thinking"] = getattr(coordinator, "latest_thinking", None)
        _evict_debate_checkpoint(checkpoint_key)
        return datas
    except Exception as e:
        logger.error(
            "Error during debate synthesis: %s",
            MedSyntisAgent._summarize_validation_error(e),
        )
        raise e
    finally:
        del coordinator
        gc.collect()
