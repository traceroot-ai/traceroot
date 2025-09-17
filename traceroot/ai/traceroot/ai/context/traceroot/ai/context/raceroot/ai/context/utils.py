from typing import List
from .models import ContextNode

def flatten_tree(root: ContextNode) -> List[ContextNode]:
    """Utility: returns all nodes in the tree, depth-first."""
    result = []
    stack = [root]
    while stack:
        node = stack.pop()
        result.append(node)
        stack.extend(node.children)
    return result

def count_nodes(root: ContextNode) -> int:
    """Count all nodes in the tree."""
    return len(flatten_tree(root))
