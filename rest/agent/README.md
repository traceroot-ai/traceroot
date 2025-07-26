# TraceRoot Agent Framework

## Overview

The TraceRoot Agent Framework is a framework for building agents that can interact with the TraceRoot with structured logging, tracing and source code data across different platforms. It can answer any questions related to the source code, tracing and logging data. It can also create related issues and PRs on GitHub. It has following benefits:

1. High accuracy when answering questions related to the source code, tracing and logging data.
1. Least token or context usage.
1. General usage including question answering, logging summarization, issue and PR.
1. Explainability for agent's summarization or answers.

## Context Model

- It's important to have an intelligent context model that extracts required context information for debugging.
- It's also important to ensure the context is as clean as possible and also reduce the context size.

TraceRoot.AI proposes a specialized context model as follows:

<div align="center">
  <a href="https://traceroot.ai/">
    <img src="../../misc/images/agent-context.svg" alt="Context Model" width="80%">
  </a>
</div>

For now it contains mainly five parts:

1. A data mixer that mixes source code (optional), tracing and logging data.
1. A heterogeneous tree constructor that constructs the mixed data into a tree with two different types of nodes (span node and log node).
1. An LLM based feature filter that filters out useless features from the heterogeneous tree.
1. An LLM based structure filter that filters out useless nodes from the heterogeneous tree. This step can also involve human in the loop, which helps to filter out unused nodes.
1. Hierarchical and temporal encoding for the heterogeneous tree.

## Chunking

## Explainability

## Multi-Agent System
