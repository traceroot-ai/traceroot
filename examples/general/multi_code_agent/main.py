import os
from typing import Any, TypedDict

import traceroot
from code_agent import create_code_agent
from dotenv import load_dotenv
from execution_agent import create_execution_agent
from langgraph.graph import END, StateGraph
from plan_agent import create_plan_agent
from summarize_agent import create_summarize_agent

load_dotenv()

logger = traceroot.get_logger()


class AgentState(TypedDict):
    query: str
    is_coding: bool
    plan: str
    code: str
    execution_result: dict[str, Any]
    response: str | None = None
    retry_count: int
    max_retries: int
    previous_attempts: list[dict[str, Any]]


class MultiAgentSystem:

    def __init__(self):
        self.plan_agent = create_plan_agent()
        self.code_agent = create_code_agent()
        self.execution_agent = create_execution_agent()
        self.summarize_agent = create_summarize_agent()

        self.graph = self._build_graph()

    def _build_graph(self):
        workflow = StateGraph(AgentState)

        # Add nodes
        workflow.add_node("planning", self.plan_node)
        workflow.add_node("coding", self.code_node)
        workflow.add_node("execute", self.execute_node)
        workflow.add_node("summarize", self.summarize_node)

        # Add edges
        workflow.set_entry_point("planning")
        workflow.add_conditional_edges("planning", self.should_code, {
            "code": "coding",
            "end": "summarize"
        })

        workflow.add_edge("coding", "execute")
        workflow.add_edge("execute", "summarize")
        workflow.add_conditional_edges("summarize", self.should_retry, {
            "retry": "planning",
            "end": END
        })

        return workflow.compile()

    def plan_node(self, state: AgentState) -> AgentState:
        # Check if we're coming from a retry (execution failure)
        is_retry = (state["retry_count"] > 0 or
                    (state.get("execution_result", {}).get("success") is False
                     and state.get("code", "") != ""))

        if is_retry:
            # Store the previous attempt including summarization
            previous_attempt = {
                "plan": state.get("plan", ""),
                "code": state.get("code", ""),
                "execution_result": state.get("execution_result", {}),
                "summary": state.get("response",
                                     "")  # Include previous summary
            }
            previous_attempts = state.get("previous_attempts", [])
            previous_attempts.append(previous_attempt)

            # Get only the last retry's summarization
            last_summary = previous_attempt.get("summary", "")
            if last_summary:
                query = (f"{state['query']}\n\n\n"
                         f"Last attempt summary:\n{last_summary}")
            else:
                query = state['query']

            result = self.plan_agent.plan_query(query)

            return {
                **state,
                "is_coding": result["is_coding"],
                "plan": result["plan"] or "",
                "response": result["response"] or None,
                "previous_attempts": previous_attempts,
                "retry_count": state["retry_count"] + 1,
                # Reset execution state for new attempt
                "code": "",
                "execution_result": {}
            }
        else:
            # First attempt
            result = self.plan_agent.plan_query(state["query"])

            return {
                **state, "is_coding": result["is_coding"],
                "plan": result["plan"] or "",
                "response": result["response"] or None
            }

    def _build_retry_context(self, state: AgentState) -> str:
        """Build context string from previous failed attempts"""
        context_parts = []
        for i, attempt in enumerate(state["previous_attempts"], 1):
            context_parts.append(f"Attempt {i}:")
            context_parts.append(f"  Plan: {attempt.get('plan', 'N/A')}")
            context_parts.append(f"  Code: {attempt.get('code', 'N/A')}")
            if attempt.get('execution_result'):
                exec_result = attempt['execution_result']
                context_parts.append(
                    f"  Execution Success: {exec_result.get('success', False)}"
                )
                if not exec_result.get('success', False):
                    context_parts.append(
                        f"  Error: {exec_result.get('error', 'Unknown error')}"
                    )
                    context_parts.append(
                        f"  Stderr: {exec_result.get('stderr', '')}")
            # Include the summary from previous attempt
            if attempt.get('summary'):
                context_parts.append(
                    f"  Previous Summary: {attempt.get('summary', 'N/A')}")
            context_parts.append("")
        return "\n".join(context_parts)

    def code_node(self, state: AgentState) -> AgentState:
        # Get the last attempt's summary if available
        last_summary = ""
        if state.get("previous_attempts"):
            last_attempt = state["previous_attempts"][-1]
            last_summary = last_attempt.get("summary", "")

        code = self.code_agent.generate_code(state["query"], state["plan"],
                                             last_summary)

        return {**state, "code": code}

    def execute_node(self, state: AgentState) -> AgentState:
        # Get the last attempt's summary if available
        last_summary = ""
        if state.get("previous_attempts"):
            last_attempt = state["previous_attempts"][-1]
            last_summary = last_attempt.get("summary", "")

        execution_result = self.execution_agent.execute_code(
            state["query"], state["plan"], state["code"], last_summary)

        return {**state, "execution_result": execution_result}

    def summarize_node(self, state: AgentState) -> AgentState:
        if state["is_coding"]:
            # Get the last attempt's summary if available
            last_summary = ""
            if state.get("previous_attempts"):
                last_attempt = state["previous_attempts"][-1]
                last_summary = last_attempt.get("summary", "")

            # For coding tasks, create summary from all components
            response = self.summarize_agent.create_summary(
                state["query"], state["plan"], state["code"],
                state["execution_result"], state["retry_count"], last_summary)
        else:
            # For non-coding tasks, use the plan agent's response
            response = state["response"]

        return {**state, "response": response}

    def should_code(self, state: AgentState) -> str:
        return "code" if state["is_coding"] else "end"

    @traceroot.trace()
    def should_retry(self, state: AgentState) -> str:
        """Determine if we should retry after a failed execution"""
        # Only retry if:
        # 1. This was a coding task
        # 2. Execution failed
        # 3. We haven't exceeded max retries
        if (state["is_coding"]
                and state["execution_result"].get("success") is False
                and state["retry_count"] < state["max_retries"]):

            logger.error(f"Execution failed on attempt "
                         f"{state['retry_count'] + 1}. Retrying...")
            return "retry"
        else:
            return "end"

    def draw_and_save_graph(
        self,
        output_path: str = "./examples/multi_code_agent/multi_agent_graph.png",
    ) -> None:
        """Draw the multi-agent workflow graph and save it locally"""
        mermaid_png = self.graph.get_graph().draw_mermaid_png()
        with open(output_path, "wb") as f:
            f.write(mermaid_png)

    @traceroot.trace()
    def process_query(self, query: str) -> str:
        """Process a user query through the multi-agent system"""
        logger.info(f"Processing query: {query}")
        initial_state = {
            "query": query,
            "is_coding": False,
            "plan": "",
            "code": "",
            "execution_result": {},
            "response": None,
            "retry_count": 0,
            "max_retries": 2,
            "previous_attempts": []
        }

        result = self.graph.invoke(initial_state)
        response = result["response"]
        logger.info(f"Final response: {response}")
        return response


def main():
    if not os.getenv("OPENAI_API_KEY"):
        print("Please set your OPENAI_API_KEY environment variable")
        print("You can create a .env file with: "
              "OPENAI_API_KEY=your_api_key_here")
        return

    system = MultiAgentSystem()
    system.draw_and_save_graph()

    query = ("Given an m x n matrix, return all elements of the matrix "
             "in spiral order, where m = 1000000000 and n = 1000000000.")
    logger.info(f"Processing query:\n{query}")
    system.process_query(query)


if __name__ == "__main__":
    main()
