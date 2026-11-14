from unittest.mock import patch
import streamlit as st
from src.ui.patient_mdt.datas import (
    _extract_section_header_summary,
    _strip_markdown_inline,
    _truncate,
    render_field,
)
from src.ui.patient_mdt.translations import (
    get_logo_svg,
    translate,
    translate_domain_fr,
)
from src.domain.common.common_ressources import (
    DiscussionPriority,
    WHOPerformanceStatus,
)


def test_translation_french():
    # Set session state to French
    st.session_state["language"] = "Français"

    # Test basic labels
    assert translate("First name of the patient") == "Prénom du patient"
    assert translate("Name of the patient at birth") == "Nom de naissance du patient"
    assert translate("first_name") == "Prénom"

    # Test Enum with class labels (WHOPerformanceStatus)
    assert (
        translate(WHOPerformanceStatus._0)
        == "0 - Pas de limitation des activités (normal)"
    )

    # Test DiscussionPriority
    assert DiscussionPriority.TIME_BOUND.label_fr == "P1 · Échéance proche"

    # Test reflection
    assert translate("reflection") == "Réflexion / Synthèse du débat"
    assert (
        translate(
            "Detailed reflection, reasoning, or synthesis of the collaborative team discussion"
        )
        == "Synthèse détaillée de la discussion et du raisonnement de l'équipe"
    )

    # Test fallback
    assert translate("Some Unknown Label") == "Some Unknown Label"

    # Test domain translations
    assert translate("oncology") == "Oncologie"
    assert translate("sma") == "Amyotrophie spinale"
    assert translate_domain_fr("oncology") == "Oncologie"
    assert translate_domain_fr("sma") == "Amyotrophie spinale"

    svg_onco = get_logo_svg("oncology")
    assert "Med" in svg_onco
    assert "Syntis" in svg_onco
    assert "- Oncologie" in svg_onco

    svg_sma = get_logo_svg("sma")
    assert "- Amyotrophie spinale" in svg_sma


def test_translation_english():
    # Set session state to English
    st.session_state["language"] = "English"

    # Verify original text is returned
    assert translate("First name of the patient") == "First name of the patient"
    assert translate("first_name") == "first_name"
    assert translate(WHOPerformanceStatus._0) == "No limitation of activities (none)"
    assert DiscussionPriority.TIME_BOUND.label_en == "P1 · Time-bound"
    assert translate("reflection") == "reflection"
    assert (
        translate(
            "Detailed reflection, reasoning, or synthesis of the collaborative team discussion"
        )
        == "Detailed reflection, reasoning, or synthesis of the collaborative team discussion"
    )


def test_strip_markdown_inline_and_expander_summaries():
    st.session_state["language"] = "Français"

    assert (
        _strip_markdown_inline("**Adénocarcinome** lieberkühnien")
        == "Adénocarcinome lieberkühnien"
    )
    assert (
        _strip_markdown_inline("**Stade IIIB** (`pT3N1M0`)") == "Stade IIIB (pT3N1M0)"
    )
    assert (
        _strip_markdown_inline("- **Lésion** hépatique\n- *Adénopathie* cœliaque")
        == "Lésion hépatique; Adénopathie cœliaque"
    )
    assert (
        _strip_markdown_inline("Référence [TNCD](https://www.snfge.org) `v2024`")
        == "Référence TNCD v2024"
    )

    truncated = _truncate(
        "**Adénocarcinome** canalaire infiltrant du pancréas avec envahissement vasculaire **cT4N1M0** (`RECIST PD`)",
        max_len=85,
    )
    assert "**" not in truncated
    assert "`" not in truncated
    assert len(truncated) <= 85

    cancer_summary = _extract_section_header_summary(
        "CancerDescription",
        {
            "type_of_cancer": "**Adénocarcinome** lieberkühnien",
            "tnm_status": "**Stade IIIB** (`pT3N1M0`)",
            "recist_response": "*Réponse partielle*",
        },
    )
    assert "**" not in cancer_summary
    assert "`" not in cancer_summary
    assert "*" not in cancer_summary
    assert "Adénocarcinome lieberkühnien" in cancer_summary
    assert "Stade IIIB (pT3N1M0)" in cancer_summary

    genetic_summary = _extract_section_header_summary(
        "GeneticDiagnosis",
        {
            "smn2_copy_count": 3,
            "other_genetic_variants": "`c.123A>G` (**hétérozygote**)",
        },
    )
    assert "**" not in genetic_summary
    assert "`" not in genetic_summary
    assert "3 copie(s) SMN2" in genetic_summary
    assert "c.123A>G (hétérozygote)" in genetic_summary

    motor_summary = _extract_section_header_summary(
        "MotorFunctionStatus",
        {"sma_type": "**Type 1** (*Werdnig-Hoffmann*)"},
    )
    assert motor_summary == " — Type 1 (Werdnig-Hoffmann)"

    motor_summary_with_mfm = _extract_section_header_summary(
        "MotorFunctionStatus",
        {"sma_type": "Type 2", "mfm_total_score": 64.6},
    )
    assert motor_summary_with_mfm == " — Type 2 · MFM 64.6 %"
    assert translate("mfm_total_score") == "Score MFM Total (%)"
    assert translate("mfm_d1_score") == "MFM D1 — Debout & transferts (%)"
    assert translate("mfm_d2_score") == "MFM D2 — Axial & proximal (%)"
    assert translate("mfm_d3_score") == "MFM D3 — Distal (%)"
    assert translate("hfmse_score") == "Score HFMSE (secondaire)"


def test_render_field_multiline_markdown_block():
    st.session_state["language"] = "Français"

    with patch.object(st, "markdown") as mock_md:
        render_field("reflection", "- Point 1\n- Point 2")
        mock_md.assert_called_once_with(
            "**Réflexion / Synthèse du débat :**\n\n- Point 1\n- Point 2"
        )

    with patch.object(st, "markdown") as mock_md:
        render_field("reflection", "- Unique élément court")
        mock_md.assert_called_once_with(
            "**Réflexion / Synthèse du débat :**\n\n- Unique élément court"
        )
