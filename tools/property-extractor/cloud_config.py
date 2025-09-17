#!/usr/bin/env python3
"""
Cloud configuration integration for property documentation generation.

This module fetches cloud configuration from the cloudv2 repository to determine
which Redpanda properties are supported, editable, or readonly in cloud deployments.

Prerequisites:
    - GITHUB_TOKEN environment variable set with appropriate permissions
    - Internet connection to access GitHub API
    
Usage:
    from cloud_config import fetch_cloud_config, add_cloud_support_metadata
    
    # Fetch cloud configuration
    config = fetch_cloud_config()
    if config:
        properties = add_cloud_support_metadata(properties, config)

Error Handling:
    - Network errors: Logged with retry suggestions
    - Authentication errors: Clear instructions for token setup
    - Parsing errors: Specific file and line information
    - Missing dependencies: Installation instructions provided
"""

import os
import json
import logging
from dataclasses import dataclass
from typing import Dict, Set, Optional, List

# Check for required dependencies early
try:
    import requests
except ImportError:
    raise ImportError("Missing required dependency 'requests': install with pip install requests")

try:
    import yaml
except ImportError:
    raise ImportError("Missing required dependency 'PyYAML': install with pip install pyyaml")

# Set up logging with production-ready configuration
logger = logging.getLogger(__name__)

class CloudConfigError(Exception):
    """Base exception for cloud configuration errors."""
    pass

class GitHubAuthError(CloudConfigError):
    """Raised when GitHub authentication fails."""
    pass

class CloudConfigParsingError(CloudConfigError):
    """Raised when cloud configuration parsing fails."""
    pass

class NetworkError(CloudConfigError):
    """Raised when network operations fail."""
    pass

@dataclass
class CloudConfig:
    """Cloud configuration data for a specific version."""
    version: str
    customer_managed_configs: List[Dict]
    readonly_cluster_config: List[str]
    
    def get_editable_properties(self) -> Set[str]:
        """Get set of property names that customers can edit."""
        return {config.get('name') for config in self.customer_managed_configs if config.get('name')}
    
    def get_readonly_properties(self) -> Set[str]:
        """Get set of property names that are read-only for customers."""
        return set(self.readonly_cluster_config)
    
    def get_all_cloud_properties(self) -> Set[str]:
        """
        Return the set of all property names present in the cloud configuration (union of editable and readonly).
        
        Returns:
            Set[str]: Property names that are either customer-editable or readonly in cloud deployments.
        """
        return self.get_editable_properties() | self.get_readonly_properties()
    
    def is_byoc_only(self, property_name: str) -> bool:
        """
        Return True if the given property is defined in customer_managed_configs and its `cluster_types` list is exactly ['byoc'].
        
        Parameters:
            property_name (str): Name of the property to check.
        
        Returns:
            bool: True when a matching config entry exists and its `cluster_types` equals ['byoc']; False otherwise.
        """
        for config in self.customer_managed_configs:
            if config.get('name') == property_name:
                cluster_types = config.get('cluster_types', [])
                return cluster_types == ['byoc']
        return False


def fetch_cloud_config(github_token: Optional[str] = None) -> CloudConfig:
    """
    Fetch the latest cloud configuration from the redpanda-data/cloudv2 repository and return it as a CloudConfig.
    
    This function uses a GitHub personal access token for authentication. If `github_token` is not provided, it will read GITHUB_TOKEN or REDPANDA_GITHUB_TOKEN from the environment. It downloads the most recent versioned YAML from the repository's install-pack directory, validates expected sections (`customer_managed_configs` and `readonly_cluster_config`), and constructs a CloudConfig instance.
    
    Parameters:
        github_token (Optional[str]): Personal access token for GitHub API. If omitted, the function will try environment variables GITHUB_TOKEN or REDPANDA_GITHUB_TOKEN.
    
    Returns:
        CloudConfig: Parsed cloud configuration for the latest available version.
    
    Raises:
        GitHubAuthError: Authentication or access problems with the GitHub API (including 401/403 responses).
        NetworkError: Network connectivity or timeout failures when contacting the GitHub API.
        CloudConfigParsingError: Failure to parse or validate the repository YAML files or their expected structure.
        CloudConfigError: Generic configuration error (e.g., missing token) or unexpected internal failures.
    """
    if not github_token:
        github_token = os.environ.get('GITHUB_TOKEN') or os.environ.get('REDPANDA_GITHUB_TOKEN')
    
    if not github_token:
        error_msg = (
            "No GitHub token provided.\n"
            "Cloud configuration requires authentication to access private repositories.\n"
            "To fix this:\n"
            "1. Go to https://github.com/settings/tokens\n"
            "2. Generate a personal access token with 'repo' scope\n"
            "3. Set the token: export GITHUB_TOKEN=your_token_here\n"
            "4. Re-run the command with --cloud-support flag"
        )
        logger.error(error_msg)
        raise GitHubAuthError(error_msg)
    
    headers = {
        'Authorization': f'token {github_token}',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'Redpanda-Docs-Property-Extractor/1.0'
    }
    
    try:
        # First, list all YAML files in the install-pack directory
        logger.info("Fetching install-pack directory listing from cloudv2 repository...")
        url = 'https://api.github.com/repos/redpanda-data/cloudv2/contents/install-pack'
        
        response = requests.get(url, headers=headers, timeout=30)
        
        if response.status_code == 401:
            error_msg = (
                "GitHub authentication failed (HTTP 401).\n"
                "Possible causes:\n"
                "1. Invalid or expired GitHub token\n"
                "2. Token lacks 'repo' scope for private repositories\n"
                "3. Token user doesn't have access to redpanda-data/cloudv2\n"
                "\nTo fix:\n"
                "1. Verify token at: https://github.com/settings/tokens\n"
                "2. Ensure 'repo' scope is enabled\n"
                "3. Contact team lead if access is needed to cloudv2 repository"
            )
            logger.error(error_msg)
            raise GitHubAuthError(error_msg)
            
        elif response.status_code == 403:
            rate_limit_remaining = response.headers.get('X-RateLimit-Remaining', 'unknown')
            rate_limit_reset = response.headers.get('X-RateLimit-Reset', 'unknown')
            error_msg = (
                "GitHub API access denied (HTTP 403).\n"
                "Possible causes:\n"
                "1. API rate limit exceeded (5000 requests/hour for authenticated users)\n"
                "2. Repository access denied\n"
                f"Rate limit remaining: {rate_limit_remaining}\n"
                f"Rate limit resets at: {rate_limit_reset}\n"
                "\nTo fix:\n"
                "1. Wait for rate limit reset if exceeded\n"
                "2. Verify repository access permissions\n"
                "3. Contact team lead if repository access is needed"
            )
            logger.error(error_msg)
            raise GitHubAuthError(error_msg)
            
        elif response.status_code == 404:
            error_msg = (
                "Install-pack directory not found (HTTP 404).\n"
                "Possible causes:\n"
                "1. Directory 'install-pack' doesn't exist in cloudv2 repository\n"
                "2. Repository 'redpanda-data/cloudv2' not accessible\n"
                "3. Directory path has changed\n"
                "\nTo fix:\n"
                "1. Verify directory exists in repository\n"
                "2. Check if directory path has changed\n"
                "3. Contact cloud team for current configuration location"
            )
            logger.error(error_msg)
            raise NetworkError(error_msg)
        
        response.raise_for_status()
        
        try:
            files = response.json()
        except ValueError as e:
            error_msg = (
                f"Invalid JSON response from GitHub API: {e}\n"
                "This indicates an API format change or server error.\n"
                "Contact development team to update integration."
            )
            logger.error(error_msg)
            raise CloudConfigParsingError(error_msg)
        
        if not isinstance(files, list):
            error_msg = (
                f"Expected list of files, got {type(files)}: {files}\n"
                "This indicates an API format change.\n"
                "Contact development team to update integration."
            )
            logger.error(error_msg)
            raise CloudConfigParsingError(error_msg)
        
        # Find YAML files with version numbers
        version_files = []
        for file in files:
            if not isinstance(file, dict):
                logger.warning(f"Skipping non-dictionary file entry: {file}")
                continue
                
            file_name = file.get('name', '')
            download_url = file.get('download_url', '')
            
            if not file_name or not download_url:
                logger.warning(f"Skipping file with missing name/url: {file}")
                continue
            
            # Look for version YAML files (e.g., "25.1.yml", "25.2.yml")
            if file_name.endswith('.yml'):
                version_part = file_name.replace('.yml', '')
                # Check if it looks like a version number (e.g., "25.1", "25.2.1")
                if version_part.replace('.', '').isdigit():
                    version_files.append((version_part, download_url))
                    logger.debug(f"Found version file: {file_name} -> {version_part}")
        
        if not version_files:
            error_msg = (
                "No version YAML files found in cloudv2/install-pack directory.\n"
                "Expected files like '25.1.yml', '25.2.yml', etc.\n"
                "Available files: " + ", ".join([f.get('name', 'unknown') for f in files]) + "\n"
                "Contact cloud team to verify configuration file naming convention."
            )
            logger.error(error_msg)
            raise CloudConfigParsingError(error_msg)
        
        # Parse and filter valid version entries before sorting
        valid_versions = []
        for version_str, download_url in version_files:
            try:
                # Parse version string into tuple of integers
                version_tuple = tuple(int(part) for part in version_str.split('.'))
                valid_versions.append((version_tuple, version_str, download_url))
                logger.debug(f"Valid version parsed: {version_str} -> {version_tuple}")
            except ValueError as e:
                logger.warning(f"Skipping invalid version format: {version_str} (error: {e})")
                continue
        
        # Check if we have any valid versions
        if not valid_versions:
            error_msg = (
                "No valid version files found in cloudv2/install-pack directory.\n"
                f"Found {len(version_files)} files but none had valid version formats.\n"
                f"Available files: {[v[0] for v in version_files]}\n"
                "Expected version format: 'X.Y' or 'X.Y.Z' (e.g., '25.1', '25.2.1')\n"
                "Contact cloud team to verify configuration file naming convention."
            )
            logger.error(error_msg)
            raise CloudConfigParsingError(error_msg)
        
        # Sort by parsed version tuple and get the latest
        valid_versions.sort(key=lambda x: x[0])  # Sort by version tuple
        latest_version_tuple, latest_version, download_url = valid_versions[-1]
        
        logger.info(f"Found {len(valid_versions)} valid version files, using latest: {latest_version}")
        logger.info(f"Valid versions: {[v[1] for v in valid_versions]}")
        if len(version_files) > len(valid_versions):
            logger.info(f"Skipped {len(version_files) - len(valid_versions)} invalid version files")
        
        # Download the latest version file
        logger.info(f"Downloading configuration file for version {latest_version}...")
        response = requests.get(download_url, headers=headers, timeout=60)
        response.raise_for_status()
        
        # Parse YAML content
        try:
            config_data = yaml.safe_load(response.text)
        except yaml.YAMLError as e:
            error_msg = (
                f"Failed to parse cloud configuration YAML for version {latest_version}: {e}\n"
                f"File URL: {download_url}\n"
                "The configuration file contains invalid YAML syntax.\n"
                "Contact cloud team to fix configuration file.\n"
                f"Parse error details: {str(e)}"
            )
            logger.error(error_msg)
            raise CloudConfigParsingError(error_msg)
        
        if not isinstance(config_data, dict):
            error_msg = (
                f"Cloud configuration root is not a dictionary: {type(config_data)}\n"
                f"Version: {latest_version}\n"
                "Expected YAML file to contain a dictionary at root level.\n"
                "Contact cloud team to verify configuration file format."
            )
            logger.error(error_msg)
            raise CloudConfigParsingError(error_msg)
        
        # Extract and validate the relevant sections
        customer_managed = config_data.get('customer_managed_configs', [])
        readonly_config = config_data.get('readonly_cluster_config', [])
        
        if not isinstance(customer_managed, list):
            error_msg = (
                f"'customer_managed_configs' section is not a list: {type(customer_managed)}\n"
                f"Version: {latest_version}\n"
                "Expected format:\n"
                "customer_managed_configs:\n"
                "  - name: property_name\n"
                "    ...\n"
                "Contact cloud team to verify configuration file format."
            )
            logger.error(error_msg)
            raise CloudConfigParsingError(error_msg)
        
        if not isinstance(readonly_config, list):
            error_msg = (
                f"'readonly_cluster_config' section is not a list: {type(readonly_config)}\n"
                f"Version: {latest_version}\n"
                "Expected format:\n"
                "readonly_cluster_config:\n"
                "  - property_name_1\n"
                "  - property_name_2\n"
                "Contact cloud team to verify configuration file format."
            )
            logger.error(error_msg)
            raise CloudConfigParsingError(error_msg)
        
        # Validate customer_managed_configs structure
        for i, config in enumerate(customer_managed):
            if not isinstance(config, dict):
                logger.warning(f"customer_managed_configs[{i}] is not a dictionary: {config}, skipping")
                continue
            if 'name' not in config:
                logger.warning(f"customer_managed_configs[{i}] missing 'name' field: {config}, skipping")
        
        # Validate readonly_cluster_config structure
        for i, prop_name in enumerate(readonly_config):
            if not isinstance(prop_name, str):
                logger.warning(f"readonly_cluster_config[{i}] is not a string: {prop_name} ({type(prop_name)}), converting")
                readonly_config[i] = str(prop_name)
        
        config = CloudConfig(
            version=latest_version,
            customer_managed_configs=customer_managed,
            readonly_cluster_config=readonly_config
        )
        
        # Log summary statistics
        editable_count = len(config.get_editable_properties())
        readonly_count = len(config.get_readonly_properties())
        total_count = len(config.get_all_cloud_properties())
        
        logger.info(f"Cloud configuration loaded successfully:")
        logger.info(f"  Version: {latest_version}")
        logger.info(f"  Editable properties: {editable_count}")
        logger.info(f"  Readonly properties: {readonly_count}")
        logger.info(f"  Total cloud properties: {total_count}")
        
        return config
        
    except requests.exceptions.ConnectionError as e:
        error_msg = (
            f"Network connection failed: {e}\n"
            "Possible causes:\n"
            "1. No internet connection\n"
            "2. Corporate firewall blocking GitHub\n"
            "3. DNS resolution issues\n"
            "\nTo fix:\n"
            "1. Check internet connectivity\n"
            "2. Try: curl -I https://api.github.com\n"
            "3. Contact IT if behind corporate firewall"
        )
        logger.error(error_msg)
        raise NetworkError(error_msg)
        
    except requests.exceptions.Timeout as e:
        error_msg = (
            f"Request timeout after 30 seconds: {e}\n"
            "GitHub API may be experiencing issues.\n"
            "To fix:\n"
            "1. Check GitHub status: https://status.github.com/\n"
            "2. Try again in a few minutes\n"
            "3. Check network connectivity"
        )
        logger.error(error_msg)
        raise NetworkError(error_msg)
        
    except (GitHubAuthError, NetworkError, CloudConfigParsingError):
        # Re-raise our custom exceptions
        raise
        
    except Exception as e:
        error_msg = (
            f"Unexpected error fetching cloud configuration: {e}\n"
            "This is likely a bug in the cloud configuration integration.\n"
            "Please report this error to the development team with:\n"
            "1. Full error message above\n"
            "2. Command that triggered the error\n"
            "3. Environment details (OS, Python version)\n"
            "4. GitHub token permissions (without revealing the token)"
        )
        logger.error(error_msg)
        raise CloudConfigError(error_msg)


def add_cloud_support_metadata(properties: Dict, cloud_config: CloudConfig) -> Dict:
    """
    Annotate property definitions with cloud-support metadata derived from a CloudConfig.
    
    Mutates the provided properties dictionary in place by adding the boolean fields
    'cloud_editable', 'cloud_readonly', 'cloud_supported', and 'cloud_byoc_only' for
    each property. Only entries whose value is a dict and whose 'config_scope' is
    one of 'cluster', 'broker', or 'topic' are processed; other entries are skipped.
    
    Returns:
        The same properties dictionary, updated with cloud metadata.
    
    Raises:
        CloudConfigError: If `properties` is not a dict or if required data cannot be
            extracted from the provided CloudConfig.
    """
    if not isinstance(properties, dict):
        error_msg = f"Properties argument must be a dictionary, got {type(properties)}"
        logger.error(error_msg)
        raise CloudConfigError(error_msg)
    
    try:
        editable_props = cloud_config.get_editable_properties()
        readonly_props = cloud_config.get_readonly_properties() 
        all_cloud_props = cloud_config.get_all_cloud_properties()
    except Exception as e:
        error_msg = f"Failed to extract property sets from cloud configuration: {e}"
        logger.error(error_msg)
        raise CloudConfigError(error_msg)
    
    logger.info(f"Applying cloud metadata using configuration version {cloud_config.version}")
    logger.info(f"Cloud properties: {len(editable_props)} editable, {len(readonly_props)} readonly")
    
    # Counters for reporting
    processed_count = 0
    cloud_supported_count = 0
    editable_count = 0
    readonly_count = 0
    byoc_only_count = 0
    skipped_count = 0
    errors = []
    
    for prop_name, prop_data in properties.items():
        try:
            if not isinstance(prop_data, dict):
                error_msg = f"Property '{prop_name}' data is not a dictionary: {type(prop_data)}"
                logger.warning(error_msg)
                errors.append(error_msg)
                skipped_count += 1
                continue
            
            # Only process cluster, broker, and topic properties for cloud support
            config_scope = prop_data.get('config_scope', '')
            if config_scope not in ['cluster', 'broker', 'topic']:
                # Skip node config properties and others without cloud relevance
                skipped_count += 1
                continue
            
            processed_count += 1
            
            # Initialize cloud metadata with defaults
            prop_data['cloud_editable'] = False
            prop_data['cloud_readonly'] = False
            prop_data['cloud_supported'] = False
            prop_data['cloud_byoc_only'] = False
            
            # Determine cloud support status
            if prop_name in editable_props:
                prop_data['cloud_editable'] = True
                prop_data['cloud_readonly'] = False
                prop_data['cloud_supported'] = True
                cloud_supported_count += 1
                editable_count += 1
                
                # Check if BYOC only
                if cloud_config.is_byoc_only(prop_name):
                    prop_data['cloud_byoc_only'] = True
                    byoc_only_count += 1
                else:
                    prop_data['cloud_byoc_only'] = False
                    
            elif prop_name in readonly_props:
                prop_data['cloud_editable'] = False
                prop_data['cloud_readonly'] = True
                prop_data['cloud_supported'] = True
                prop_data['cloud_byoc_only'] = False
                cloud_supported_count += 1
                readonly_count += 1
                
            else:
                # Property not supported in cloud
                prop_data['cloud_editable'] = False
                prop_data['cloud_readonly'] = False
                prop_data['cloud_supported'] = False
                prop_data['cloud_byoc_only'] = False
                
        except Exception as e:
            error_msg = f"Error processing property '{prop_name}': {e}"
            logger.warning(error_msg)
            errors.append(error_msg)
            continue
    
    # Log comprehensive summary
    logger.info(f"Cloud metadata application completed:")
    logger.info(f"  Properties processed: {processed_count}")
    logger.info(f"  Properties skipped (non-cloud scope): {skipped_count}")
    logger.info(f"  Cloud-supported properties: {cloud_supported_count}")
    logger.info(f"    - Editable: {editable_count}")
    logger.info(f"    - Readonly: {readonly_count}")
    logger.info(f"    - BYOC-only: {byoc_only_count}")
    logger.info(f"  Self-managed only: {processed_count - cloud_supported_count}")
    
    if errors:
        logger.warning(f"Encountered {len(errors)} errors during processing:")
        for error in errors[:10]:  # Log first 10 errors
            logger.warning(f"  - {error}")
        if len(errors) > 10:
            logger.warning(f"  ... and {len(errors) - 10} more errors")
    
    # Validation checks
    if processed_count == 0:
        logger.warning("No properties were processed for cloud metadata. This may indicate:")
        logger.warning("  1. All properties are node-scoped (not cluster/broker/topic)")
        logger.warning("  2. Properties dictionary is empty")
        logger.warning("  3. Properties missing 'config_scope' field")
    
    if cloud_supported_count == 0:
        logger.warning("No cloud-supported properties found. This may indicate:")
        logger.warning("  1. Cloud configuration is empty or invalid")
        logger.warning("  2. Property names don't match between sources")
        logger.warning("  3. All properties are self-managed only")
    
    # Check for potential mismatches
    unmatched_cloud_props = (editable_props | readonly_props) - {
        name for name, data in properties.items() 
        if isinstance(data, dict) and data.get('config_scope') in ['cluster', 'broker', 'topic']
    }
    
    if unmatched_cloud_props:
        logger.info(f"Cloud configuration contains {len(unmatched_cloud_props)} properties not found in extracted properties:")
        for prop in sorted(list(unmatched_cloud_props)[:10]):  # Show first 10
            logger.info(f"  - {prop}")
        if len(unmatched_cloud_props) > 10:
            logger.info(f"  ... and {len(unmatched_cloud_props) - 10} more")
        logger.info("This is normal if cloud config includes deprecated or future properties.")
    
    return properties


if __name__ == "__main__":
    # Test the cloud config fetcher
    logging.basicConfig(level=logging.INFO)
    config = fetch_cloud_config()
    if config:
        print(f"Successfully fetched cloud config for version {config.version}")
        print(f"Editable properties: {len(config.get_editable_properties())}")
        print(f"Readonly properties: {len(config.get_readonly_properties())}")
    else:
        print("Failed to fetch cloud configuration")
