"""Generated output must emit prop macros, never the deprecated config_ref."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "tools" / "property-extractor"))

from property_extractor import apply_property_overrides


def _apply(description, overrides=None):
    properties = {"some_prop": {"name": "some_prop", "description": description}}
    return apply_property_overrides(properties, overrides or {})["some_prop"]["description"]


def test_linked_config_ref_becomes_prop():
    result = _apply(
        "See config_ref:tombstone_retention_ms,true,properties/cluster-properties[] for details."
    )
    assert result == "See prop:tombstone_retention_ms[link=true] for details."


def test_payload_repeating_the_name_is_dropped():
    result = _apply(
        "Set config_ref:kafka_max_message_size_upper_limit_bytes,true,properties/cluster-properties[`kafka_max_message_size_upper_limit_bytes`]."
    )
    assert result == "Set prop:kafka_max_message_size_upper_limit_bytes[link=true]."


def test_differing_payload_becomes_text_override():
    result = _apply("Use config_ref:log_segment_size,true,cluster-properties[segment size].")
    assert result == "Use prop:log_segment_size[link=true,text=segment size]."


def test_unlinked_config_ref_converts_without_link():
    result = _apply("Tune config_ref:enable_rack_awareness,false[] first.")
    assert result == "Tune prop:enable_rack_awareness[] first."


def test_overridden_descriptions_are_normalized_too():
    properties = {"some_prop": {"name": "some_prop", "description": "old"}}
    overrides = {
        "properties": {
            "some_prop": {
                "description": "See config_ref:enable_rack_awareness,true,properties/cluster-properties[]."
            }
        }
    }
    result = apply_property_overrides(properties, overrides)
    assert result["some_prop"]["description"] == "See prop:enable_rack_awareness[link=true]."


def test_descriptions_without_config_ref_are_untouched():
    text = "Plain description with `backticks` and xref:manage:page.adoc[a link]."
    assert _apply(text) == text
