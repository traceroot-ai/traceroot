from typing import Any, Optional

import traceroot
from dotenv import load_dotenv
from langchain.prompts import ChatPromptTemplate
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

load_dotenv()

logger = traceroot.get_logger()


class PlanResponse(BaseModel):
    """Structured response model for the planning agent"""
    is_coding: bool = Field(description="Whether the query is coding-related")
    plan: Optional[str] = Field(default=None,
                                description="Detailed plan for coding tasks")
    response: Optional[str] = Field(
        default=None, description="Direct response for non-coding queries")


class PlanAgent:

    def __init__(self):
        self.llm = ChatOpenAI(model="gpt-4o", temperature=0)
        self.system_prompt = (
            "You are a planning agent. "
            "Your job is to analyze user queries and create plans. "
            "IMPORTANT: You must determine if the query is "
            "coding-related or not. "
            "If the query is coding-related (involves programming, "
            "writing code, software development, etc.), set is_coding to true "
            "and provide a detailed plan in the 'plan' field.\n"
            "If the query is NOT coding-related, set is_coding to false "
            "and provide your direct response in the 'response' field.\n"
            "If last summary from previous attempts is provided, "
            "learn from the failures and create an improved plan that "
            "addresses the issues encountered in previous attempts.\n"
            "Be concise and innovative.\n"
            "Focus on identifying root causes and proposing different "
            "approaches to avoid repeating the same mistakes.")
        self.plan_prompt = ChatPromptTemplate.from_messages([
            ("system", self.system_prompt), ("human", "{query}")
        ])

    @traceroot.trace()
    def plan_query(self, query: str) -> dict[str, Any]:
        """Process user query and determine if it's coding-related"""
        structured_llm = self.llm.with_structured_output(PlanResponse)
        chain = self.plan_prompt | structured_llm

        formatted_prompt = self.plan_prompt.format(query=query)
        logger.info(f"PLAN AGENT prompt:\n{formatted_prompt}")

        response = chain.invoke({"query": query})

        if response.is_coding:
            logger.warning(f"Coding-related query: {query}")
            logger.warning(f"Planned response: {response.plan}")
        else:
            logger.warning(f"Non-coding query: {query}")
            logger.warning(f"Direct response: {response.response}")

        return {
            "is_coding": response.is_coding,
            "plan": response.plan,
            "query": query,
            "response": response.response
        }


def create_plan_agent():
    return PlanAgent()
