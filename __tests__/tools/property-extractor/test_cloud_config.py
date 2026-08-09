"""
Unit tests for cloud support metadata in cloud_config.

Covers alias-aware matching: a property renamed in Redpanda still carries an
`aliases` array with its old name, and the cloud configuration may reference
that old name. Membership checks must match on the current name or any alias.
"""

import unittest
import sys
import os

# Add property-extractor directory to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '../../../tools/property-extractor'))

from cloud_config import CloudConfig, add_cloud_support_metadata


def make_cloud_config(editable=None, readonly=None):
    """Build a CloudConfig with the given editable and readonly property names."""
    return CloudConfig(
        version="test",
        customer_managed_configs=[
            entry if isinstance(entry, dict) else {"name": entry}
            for entry in (editable or [])
        ],
        readonly_cluster_config=list(readonly or []),
    )


class TestAliasAwareCloudMatching(unittest.TestCase):
    """Test that cloud membership checks match property names and aliases."""

    def test_direct_name_match_still_works(self):
        cloud = make_cloud_config(editable=["log_retention_ms"])
        properties = {
            "log_retention_ms": {"name": "log_retention_ms", "config_scope": "cluster"},
        }

        result = add_cloud_support_metadata(properties, cloud)

        self.assertTrue(result["log_retention_ms"]["cloud_supported"])
        self.assertTrue(result["log_retention_ms"]["cloud_editable"])

    def test_editable_match_via_alias(self):
        """Cloud list contains the old name, property registered under the new name."""
        cloud = make_cloud_config(editable=["delete_retention_ms"])
        properties = {
            "log_retention_ms": {
                "name": "log_retention_ms",
                "config_scope": "cluster",
                "aliases": ["delete_retention_ms"],
            },
        }

        result = add_cloud_support_metadata(properties, cloud)

        self.assertTrue(result["log_retention_ms"]["cloud_supported"])
        self.assertTrue(result["log_retention_ms"]["cloud_editable"])
        self.assertFalse(result["log_retention_ms"]["cloud_readonly"])

    def test_readonly_match_via_alias(self):
        cloud = make_cloud_config(readonly=["old_readonly_name"])
        properties = {
            "new_readonly_name": {
                "name": "new_readonly_name",
                "config_scope": "cluster",
                "aliases": ["old_readonly_name"],
            },
        }

        result = add_cloud_support_metadata(properties, cloud)

        self.assertTrue(result["new_readonly_name"]["cloud_supported"])
        self.assertTrue(result["new_readonly_name"]["cloud_readonly"])
        self.assertFalse(result["new_readonly_name"]["cloud_editable"])

    def test_byoc_check_uses_the_alias_the_cloud_config_knows(self):
        cloud = make_cloud_config(editable=[{"name": "old_name", "cluster_types": ["byoc"]}])
        properties = {
            "new_name": {
                "name": "new_name",
                "config_scope": "cluster",
                "aliases": ["old_name"],
            },
        }

        result = add_cloud_support_metadata(properties, cloud)

        self.assertTrue(result["new_name"]["cloud_byoc_only"])

    def test_unmatched_property_stays_unsupported(self):
        cloud = make_cloud_config(editable=["something_else"])
        properties = {
            "new_name": {
                "name": "new_name",
                "config_scope": "cluster",
                "aliases": ["also_unrelated"],
            },
        }

        result = add_cloud_support_metadata(properties, cloud)

        self.assertFalse(result["new_name"]["cloud_supported"])
        self.assertFalse(result["new_name"]["cloud_editable"])
        self.assertFalse(result["new_name"]["cloud_readonly"])

    def test_property_without_aliases_field_is_handled(self):
        cloud = make_cloud_config(editable=["other_property"])
        properties = {
            "plain_property": {"name": "plain_property", "config_scope": "cluster"},
        }

        result = add_cloud_support_metadata(properties, cloud)

        self.assertFalse(result["plain_property"]["cloud_supported"])

    def test_alias_match_logs_info_naming_the_alias(self):
        cloud = make_cloud_config(editable=["delete_retention_ms"])
        properties = {
            "log_retention_ms": {
                "name": "log_retention_ms",
                "config_scope": "cluster",
                "aliases": ["delete_retention_ms"],
            },
        }

        with self.assertLogs("cloud_config", level="INFO") as captured:
            add_cloud_support_metadata(properties, cloud)

        output = "\n".join(captured.output)
        self.assertIn("via alias 'delete_retention_ms'", output)


if __name__ == "__main__":
    unittest.main()
