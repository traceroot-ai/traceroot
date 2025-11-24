import asyncio
from typing import Dict, List, Any, Optional
from .models import ContextNode, DebugContext
from .utils import flatten_tree, count_nodes

class ContextAggregator:
    """AI-powered, TraceRoot-compliant context aggregation for debugging"""

    def __init__(self, llm_client):
        self.llm_client = llm_client

    async def aggregate_context(self, trace_data: Dict[str, Any]) -> DebugContext:
        logger = traceroot.get_logger()
        # Step 1: Build heterogeneous tree (spans and logs)
        root_node = self._build_tree(trace_data)
        # Step 2: LLM feature filter
        filtered_tree = await self._llm_feature_filter(root_node)
        # Step 3: LLM structure filter (optional human-in-the-loop)
        pruned_tree = await self._llm_structure_filter(filtered_tree)
        # Step 4: Hierarchical/temporal encoding
        self._encode_tree(pruned_tree)
        # Step 5: Analyze error patterns using AI
        error_patterns = await self._analyze_error_patterns(pruned_tree)
        # Step 6: Calculate performance metrics
        performance_metrics = self._calculate_performance_metrics(pruned_tree)
        # Step 7: Get GitHub context if available
        github_context = await self._fetch_github_context(trace_data.get('github_info'))

        logger.info({
            "trace_id": trace_data['trace_id'],
            "tree_nodes": count_nodes(pruned_tree),
            "error_patterns_found": len(error_patterns)
        }, f"Context aggregated for trace {trace_data['trace_id']}")

        return DebugContext(
            trace_id=trace_data['trace_id'],
            root_node=pruned_tree,
            github_context=github_context,
            error_patterns=error_patterns,
            performance_metrics=performance_metrics
        )

    def _build_tree(self, trace_data: Dict[str, Any]) -> ContextNode:
        """Constructs a heterogeneous tree from spans and logs."""
        spans = trace_data.get('spans', [])
        logs = trace_data.get('logs', [])
        # Build root node
        root = ContextNode(node_type='root', data={'trace_id': trace_data['trace_id']})
        # Build span nodes
        span_nodes = []
        for span in spans:
            node = ContextNode(
                node_type='span',
                data=span,
                timestamp=span.get('start_time'),
                duration=span.get('duration')
            )
            span_nodes.append(node)
        # Build log nodes and attach to spans (if possible)
        log_nodes = []
        for log in logs:
            node = ContextNode(
                node_type='log',
                data=log,
                timestamp=log.get('timestamp')
            )
            log_nodes.append(node)
            # Attach log to its span if span_id exists
            if 'span_id' in log and log['span_id']:
                for span_node in span_nodes:
                    if span_node.data.get('span_id') == log['span_id']:
                        span_node.children.append(node)
                        node.parent = span_node
                        break
                else:
                    root.children.append(node)
                    node.parent = root
            else:
                root.children.append(node)
                node.parent = root
        # Attach spans to root
        for node in span_nodes:
            root.children.append(node)
            node.parent = root
        return root

    async def _llm_feature_filter(self, root_node: ContextNode) -> ContextNode:
        """LLM-based feature filtering: remove useless fields from nodes."""
        # Flatten tree for feature filtering
        all_nodes = flatten_tree(root_node)
        for node in all_nodes:
            prompt = f"Given this node data of type {node.node_type}: {node.data}\nList only the most essential features for root cause debugging. Remove irrelevant fields."
            features = await self.llm_client.generate(prompt)
            if features:
                # Keep only the features returned by LLM
                essential = [x.strip() for x in features.split('\n') if x.strip()]
                node.data = {k: v for k, v in node.data.items() if k in essential}
        return root_node

    async def _llm_structure_filter(self, root_node: ContextNode) -> ContextNode:
        """LLM-based structure filtering: prune useless nodes."""
        all_nodes = flatten_tree(root_node)
        for node in all_nodes:
            prompt = f"Should this node of type {node.node_type} with data {node.data} be kept for debugging context? Reply ONLY 'yes' or 'no'."
            keep = await self.llm_client.generate(prompt)
            if keep.strip().lower() != 'yes':
                if node.parent:
                    node.parent.children.remove(node)
        return root_node

    def _encode_tree(self, root_node: ContextNode):
        """Hierarchical and temporal encoding (may be extended)."""
        # This can be as simple as traversing the tree and setting hierarchy or more advanced encodings
        pass

    async def _analyze_error_patterns(self, root_node: ContextNode) -> List[str]:
        """AI-powered error pattern detection from tree."""
        errors = []
        for node in flatten_tree(root_node):
            if node.node_type == 'span' and node.data.get('status', {}).get('code') == 'ERROR':
                errors.append(f"Span error: {node.data.get('status', {}).get('message', '')}")
            if node.node_type == 'log' and node.data.get('level') in ['ERROR', 'FATAL']:
                errors.append(f"Log error: {node.data.get('message', '')}")
        if not errors:
            return []
        prompt = f"Analyze these errors and identify common patterns for debugging:\n{errors}\nFocus on failure modes, bottlenecks, and integration issues."
        patterns = await self.llm_client.generate(prompt)
        return [x.strip() for x in patterns.split('\n') if x.strip()] if patterns else []

    def _calculate_performance_metrics(self, root_node: ContextNode) -> Dict[str, float]:
        """Aggregate performance metrics from spans."""
        durations = []
        for node in flatten_tree(root_node):
            if node.node_type == 'span' and node.duration:
                durations.append(node.duration)
        return {
            "avg_duration": sum(durations) / len(durations) if durations else 0.0,
            "max_duration": max(durations) if durations else 0.0,
            "min_duration": min(durations) if durations else 0.0,
        }

    async def _fetch_github_context(self, github_info: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        """Fetch GitHub context (stub example)."""
        if not github_info:
            return None
        # Example: fetch PR or issue details from GitHub API if needed
        return github_info
