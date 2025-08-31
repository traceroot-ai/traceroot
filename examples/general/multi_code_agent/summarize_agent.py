from typing import Any, Dict

import traceroot
from dotenv import load_dotenv
from langchain.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI

load_dotenv()

logger = traceroot.get_logger()


class SummarizeAgent:

    def __init__(self):
        self.llm = ChatOpenAI(model="gpt-4o", temperature=0)
        self.system_prompt = (
            "You are a summarization agent. "
            "Your job is to create a comprehensive final response "
            "based on the user's original query, the plan, "
            "the Python code, and the execution results. "
            "Create a clear, helpful response that addresses "
            "the user's original question, explains what was "
            "accomplished, shows the results if execution was "
            "successful, explains any issues if execution failed, "
            "and provides the code if it's relevant to show. "
            "Keep your response conversational and helpful. "
            "Focus on what the user wanted to achieve and what was "
            "accomplished. If historical context is provided, "
            "acknowledge the iterative process and explain how "
            "previous attempts helped improve the final solution.")
        self.user_prompt = (
            "User Query: {query}\n"
            "Plan: {plan}\n"
            "Generated Code: {code}\n"
            "Execution Results:\n"
            "- Success: {success}\n"
            "- Output: {output}\n"
            "- Error: {error}\n"
            "Retry Count: {retry_count}{historical_context}\n"
            "Please provide a comprehensive summary and final response.")
        self.summarize_prompt = ChatPromptTemplate.from_messages([
            ("system", self.system_prompt), ("human", self.user_prompt)
        ])

    @traceroot.trace()
    def create_summary(
        self,
        query: str,
        plan: str,
        code: str,
        execution_result: Dict[str, Any],
        retry_count: int = 0,
        historical_context: str = "",
    ) -> str:
        success = execution_result.get("success", False)
        output = execution_result.get("stdout", "")
        error = execution_result.get("stderr", "")

        # If there's no output but success, mention that
        if success and not output.strip():
            output = "Code executed successfully with no output"

        # Format historical context for prompt
        formatted_historical_context = ""
        if historical_context:
            formatted_historical_context = (
                f"\n\nHistorical Context from Previous Attempts:\n"
                f"{historical_context}")

        chain = self.summarize_prompt | self.llm

        formatted_prompt = self.summarize_prompt.format(
            query=query,
            plan=plan,
            code=code,
            success=success,
            output=output,
            error=error,
            retry_count=retry_count,
            historical_context=formatted_historical_context,
        )
        logger.info(f"SUMMARIZE AGENT prompt:\n{formatted_prompt}")

        response = chain.invoke({
            "query":
            query,
            "plan":
            plan,
            "code":
            code,
            "success":
            success,
            "output":
            output,
            "error":
            error,
            "retry_count":
            retry_count,
            "historical_context":
            formatted_historical_context
        })

        logger.info(f"Summarized response: {response.content}")

        return response.content


def create_summarize_agent():
    return SummarizeAgent()
