# TraceRoot Agent Framework

## Overview

The TraceRoot Agent Framework is a framework for building agents that can interact with the TraceRoot platform with structured logging, tracing and source code data across different platforms. It can answer any questions related to the source code, tracing and logging data. It can also create related issues and PRs on GitHub. It has following benefits:

1. High accuracy when answering questions related to the source code, tracing and logging data.
2. Least token or context usage.
3. General usage including question answering, logging summarization, issue and PR.
4. Explainability for agent's summarization or answers.

## Context Model

* It's important to have an intelligent context model that extracts required context information for debugging.
* It's also important to ensure the context is as clean as possible and also reduce the context size.

TraceRoot.AI proposes a specialized context model as follows:

<div align="center">
  <a href="https://traceroot.ai/">
    <img src="../../misc/images/agent-context.svg" alt="Context Model" width="80%">
  </a>
</div>

For now it contains mainly five parts:

1. A data mixer that mixes source code (optional), tracing and logging data.
2. A heterogeneous tree constructor that constructs the mixed data into a tree with two different types of nodes (span node and log node).
3. An LLM based feature filter that filters out useless features from the heterogeneous tree.
4. An LLM based structure filter that filters out useless nodes from the heterogeneous tree. This step can also involve human in the loop, which helps to filter out unused nodes.
5. Hierarchical and temporal encoding for the heterogeneous tree.


## Chunking

TODO: Add TraceRoot's specialized chunking.


## Explainability

TODO: Add TraceRoot's specialized explainability.


## Multi-Agent System

TODO: Add TraceRoot's specialized multi-agent framework.
