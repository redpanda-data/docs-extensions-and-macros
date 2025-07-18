import logging
from collections import defaultdict

logger = logging.getLogger("metrics_bag")


class MetricsBag:
    """Container for storing and managing extracted metrics"""
    
    def __init__(self):
        self._metrics = {}
    
    def add_metric(self, name, metric_type, description="", labels=None, 
                   file="", constructor="", line_number=None, group_name=None, full_name=None, **kwargs):
        """Add a metric to the bag"""
        if labels is None:
            labels = []
        
        # Create unique key for the metric
        key = name
        
        # If metric already exists, merge information
        if key in self._metrics:
            existing = self._metrics[key]
            
            # Update description if current one is empty
            if not existing.get("description") and description:
                existing["description"] = description
            
            # Merge labels
            existing_labels = set(existing.get("labels", []))
            new_labels = set(labels)
            existing["labels"] = sorted(existing_labels | new_labels)
            
            # Add file location if not already present
            files = existing.get("files", [])
            file_info = {"file": file, "line": line_number}
            if file_info not in files:
                files.append(file_info)
                existing["files"] = files
        else:
            # Create new metric entry
            metric_data = {
                "name": name,
                "type": metric_type,
                "description": description,
                "labels": sorted(labels) if labels else [],
                "constructor": constructor,
                "files": [{"file": file, "line": line_number}],
                "group_name": group_name,
                "full_name": full_name
            }
            
            # Add any additional kwargs
            metric_data.update(kwargs)
            
            self._metrics[key] = metric_data
        
        logger.debug(f"Added/updated metric: {name}")
    
    def get_metric(self, name):
        """Get a specific metric by name"""
        return self._metrics.get(name)
    
    def get_all_metrics(self):
        """Get all metrics as a dictionary"""
        return self._metrics.copy()
    
    def get_metrics_by_type(self, metric_type):
        """Get all metrics of a specific type"""
        return {
            name: metric for name, metric in self._metrics.items()
            if metric.get("type") == metric_type
        }
    
    def get_metrics_by_constructor(self, constructor):
        """Get all metrics created by a specific constructor"""
        return {
            name: metric for name, metric in self._metrics.items()
            if metric.get("constructor") == constructor
        }
    
    def merge(self, other_bag):
        """Merge another MetricsBag into this one"""
        if not isinstance(other_bag, MetricsBag):
            raise ValueError("Can only merge with another MetricsBag instance")
        
        for name, metric in other_bag.get_all_metrics().items():
            self.add_metric(
                name=metric["name"],
                metric_type=metric["type"],
                description=metric.get("description", ""),
                labels=metric.get("labels", []),
                file=metric.get("files", [{}])[0].get("file", ""),
                constructor=metric.get("constructor", ""),
                line_number=metric.get("files", [{}])[0].get("line")
            )
    
    def filter_by_prefix(self, prefix):
        """Get metrics that start with a specific prefix"""
        return {
            name: metric for name, metric in self._metrics.items()
            if name.startswith(prefix)
        }
    
    def get_statistics(self):
        """Get statistics about the metrics in the bag"""
        stats = {
            "total_metrics": len(self._metrics),
            "by_type": defaultdict(int),
            "by_constructor": defaultdict(int),
            "with_description": 0,
            "with_labels": 0
        }
        
        for metric in self._metrics.values():
            stats["by_type"][metric.get("type", "unknown")] += 1
            stats["by_constructor"][metric.get("constructor", "unknown")] += 1
            
            if metric.get("description"):
                stats["with_description"] += 1
            
            if metric.get("labels"):
                stats["with_labels"] += 1
        
        # Convert defaultdict to regular dict for JSON serialization
        stats["by_type"] = dict(stats["by_type"])
        stats["by_constructor"] = dict(stats["by_constructor"])
        
        return stats
    
    def to_dict(self):
        """Convert the metrics bag to a dictionary for JSON serialization"""
        return {
            "metrics": self._metrics,
            "statistics": self.get_statistics()
        }
    
    def to_prometheus_format(self):
        """Convert metrics to a Prometheus-like format"""
        prometheus_metrics = []
        
        for name, metric in self._metrics.items():
            prometheus_metric = {
                "name": name,
                "help": metric.get("description", ""),
                "type": metric.get("type", "unknown")
            }
            
            if metric.get("labels"):
                prometheus_metric["labels"] = metric["labels"]
            
            prometheus_metrics.append(prometheus_metric)
        
        return prometheus_metrics
    
    def __len__(self):
        return len(self._metrics)
    
    def __iter__(self):
        return iter(self._metrics.items())
    
    def __contains__(self, name):
        return name in self._metrics
    
    def __getitem__(self, name):
        return self._metrics[name]
    
    def __repr__(self):
        return f"MetricsBag({len(self._metrics)} metrics)"
