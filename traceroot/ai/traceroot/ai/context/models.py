from dataclasses import dataclass, field
from typing import Dict, List, Any, Optional

@dataclass
class ContextNode:
    """Node in the heterogeneous tree (span or log)"""
    node_type: str  # 'span' or 'log'
    data: Dict[str, Any]
    children: List['ContextNode'] = field(default_factory=list)
    parent: Optional['ContextNode'] = None
    timestamp: Optional[float] = None
    duration: Optional[float] = None

@dataclass
class DebugContext:
    trace_id: str
    root_node: ContextNode
    github_context: Optional[Dict[str, Any]] = None
    error_patterns: List[str] = field(default_factory=list)
    performance_metrics: Dict[str, float] = field(default_factory=dict)
