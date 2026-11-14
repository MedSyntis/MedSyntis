"""Unit tests for Issue #12: P1-P4 MDT Discussion Priority scale (TDD)."""

import unittest

from src.domain.common.common_ressources import (
    DiscussionPriority,
    PriorityAssessment,
    merge_priority,
    suggest_priority,
)


class TestDiscussionPriorityDomain(unittest.TestCase):
    def test_enum_values_codes_and_sort_rank_with_not_assessed_after_p2(self):
        self.assertEqual(int(DiscussionPriority.TIME_BOUND), 1)
        self.assertEqual(int(DiscussionPriority.DECISION_NEEDED), 2)
        self.assertEqual(int(DiscussionPriority.STANDARD_SIGN_OFF), 3)
        self.assertEqual(int(DiscussionPriority.INFORMATION), 4)
        self.assertEqual(int(DiscussionPriority.NOT_ASSESSED), 9)

        # Q1 decision: P1 -> P2 -> NOT_ASSESSED -> P3 -> P4
        ordered = sorted(
            [
                DiscussionPriority.INFORMATION,
                DiscussionPriority.STANDARD_SIGN_OFF,
                DiscussionPriority.NOT_ASSESSED,
                DiscussionPriority.DECISION_NEEDED,
                DiscussionPriority.TIME_BOUND,
            ],
            key=lambda p: p.sort_rank,
        )
        self.assertEqual(
            ordered,
            [
                DiscussionPriority.TIME_BOUND,
                DiscussionPriority.DECISION_NEEDED,
                DiscussionPriority.NOT_ASSESSED,
                DiscussionPriority.STANDARD_SIGN_OFF,
                DiscussionPriority.INFORMATION,
            ],
        )

        self.assertEqual(DiscussionPriority.TIME_BOUND.code, "P1")
        self.assertEqual(DiscussionPriority.DECISION_NEEDED.code, "P2")
        self.assertEqual(DiscussionPriority.STANDARD_SIGN_OFF.code, "P3")
        self.assertEqual(DiscussionPriority.INFORMATION.code, "P4")
        self.assertEqual(DiscussionPriority.NOT_ASSESSED.code, "NOT_ASSESSED")

    def test_from_any_parses_canonical_codes_and_integers(self):
        self.assertEqual(DiscussionPriority.from_any(1), DiscussionPriority.TIME_BOUND)
        self.assertEqual(
            DiscussionPriority.from_any("P1"), DiscussionPriority.TIME_BOUND
        )
        self.assertEqual(
            DiscussionPriority.from_any("2"), DiscussionPriority.DECISION_NEEDED
        )
        self.assertEqual(
            DiscussionPriority.from_any("P3"), DiscussionPriority.STANDARD_SIGN_OFF
        )
        self.assertEqual(
            DiscussionPriority.from_any("P4"), DiscussionPriority.INFORMATION
        )
        self.assertEqual(
            DiscussionPriority.from_any("NOT_ASSESSED"), DiscussionPriority.NOT_ASSESSED
        )
        self.assertEqual(
            DiscussionPriority.from_any(9), DiscussionPriority.NOT_ASSESSED
        )
        self.assertIsNone(DiscussionPriority.from_any("unknown_string"))

    def test_suggest_priority_deterministic_rules(self):
        # Incomplete record -> NOT_ASSESSED
        empty_res = suggest_priority({})
        self.assertEqual(empty_res.level, DiscussionPriority.NOT_ASSESSED)
        self.assertEqual(empty_res.source, "rule")

        # Progression or scheduled surgery -> P1 Time-bound
        prog_res = suggest_priority(
            {
                "TumorLocation": {"tumor_location": "Pancreas"},
                "CancerDescription": {
                    "type_of_cancer": "Ductal adenocarcinoma",
                    "recist_response": "Progressive Disease (PD)",
                },
            }
        )
        self.assertEqual(prog_res.level, DiscussionPriority.TIME_BOUND)
        self.assertEqual(prog_res.source, "rule")

        sched_res = suggest_priority(
            {
                "TumorLocation": {"tumor_location": "Colon"},
                "PlannedCurativeSurgery": {"planned_curative_surgery": True},
            }
        )
        self.assertEqual(sched_res.level, DiscussionPriority.TIME_BOUND)

        # Active pathology without immediate deadline -> P2 Decision needed
        decision_res = suggest_priority(
            {
                "TumorLocation": {"tumor_location": "Colon"},
                "CancerDescription": {"type_of_cancer": "Adenocarcinoma"},
            }
        )
        self.assertEqual(decision_res.level, DiscussionPriority.DECISION_NEEDED)

    def test_merge_priority_respects_manual_override_and_non_downgrade_rule(self):
        rule_p2 = PriorityAssessment(
            level=DiscussionPriority.DECISION_NEEDED,
            reason="Active diagnostic decision",
            source="rule",
        )
        ai_p1 = PriorityAssessment(
            level=DiscussionPriority.TIME_BOUND,
            reason="Upcoming surgical window",
            source="ai",
        )
        ai_p3 = PriorityAssessment(
            level=DiscussionPriority.STANDARD_SIGN_OFF,
            reason="Standard adjuvant validation",
            source="ai",
        )
        manual_p4 = PriorityAssessment(
            level=DiscussionPriority.INFORMATION,
            reason="Physician downgraded to information only",
            source="manual",
        )

        # AI can elevate P2 -> P1
        elevated = merge_priority(rule=rule_p2, ai=ai_p1, manual=None)
        self.assertEqual(elevated.level, DiscussionPriority.TIME_BOUND)
        self.assertEqual(elevated.source, "ai")

        # AI cannot downgrade P2 -> P3
        kept = merge_priority(rule=rule_p2, ai=ai_p3, manual=None)
        self.assertEqual(kept.level, DiscussionPriority.DECISION_NEEDED)
        self.assertEqual(kept.source, "rule")

        # Manual override always wins (even if lower than rule or AI)
        overridden = merge_priority(rule=rule_p2, ai=ai_p1, manual=manual_p4)
        self.assertEqual(overridden.level, DiscussionPriority.INFORMATION)
        self.assertEqual(overridden.source, "manual")


if __name__ == "__main__":
    unittest.main()
