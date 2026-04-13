"""TraceRoot Development Environment TMUX Tools.

This package provides a tmux-based development environment orchestrator.
It launches multiple tmux windows running different services in parallel,
with automatic prerequisite checking and session reattachment.

Usage from the root of the traceroot repository:

    make dev            # Full stack development environment
    make dev-reset      # Nuclear reset and restart
"""
