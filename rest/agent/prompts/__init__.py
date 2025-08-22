# rest/agent/prompts/__init__.py

from .agent_prompts import AGENT_SYSTEM_PROMPT
from .chat_prompts import CHAT_SYSTEM_PROMPT, LOCAL_MODE_APPENDIX

__all__ = [
    "CHAT_SYSTEM_PROMPT",
    "LOCAL_MODE_APPENDIX",
    "AGENT_SYSTEM_PROMPT",
]
