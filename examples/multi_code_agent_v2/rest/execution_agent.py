import logging
import os
import re
import subprocess
import tempfile
from typing import Dict

logger = logging.getLogger(__name__)


def _clean_code_snippet(code: str) -> str:
    """
    Sanitize an LLM-produced code snippet by removing Markdown code fences and
    returning the plain code only.

    Strategy:
    - If fenced blocks exist (```...``` optionally with language), extract the first
      fenced block and use it as the code to execute.
    - Otherwise, remove any stray ``` lines and return the remaining content.
    - Trim leading/trailing whitespace.
    """
    if not code:
        return code

    # Normalize line endings
    code = code.replace('\r\n', '\n').replace('\r', '\n')

    # Try to extract the first fenced block if present
    fenced_blocks = re.findall(r"```(?:\s*\w+)?\s*\n(.*?)```", code, re.DOTALL)
    if fenced_blocks:
        cleaned = fenced_blocks[0]
    else:
        # No clear fenced block; strip any stray fence lines
        lines = []
        for ln in code.split('\n'):
            s = ln.strip()
            if s.startswith('```') or s.endswith('```'):
                continue
            lines.append(ln)
        cleaned = '\n'.join(lines)

    return cleaned.strip()


class ExecutionAgent:
    """Executes code in a subprocess and returns structured results."""

    def __init__(self, python_executable: str = None):
        self.python_executable = python_executable or os.environ.get("PYTHON", "python")

    def execute_code(self, code: str, language: str = "python") -> Dict[str, object]:
        """
        Execute the provided code. Currently supports Python execution.

        Returns a dict with keys: success (bool), stdout (str), stderr (str), return_code (int)
        """
        sanitized = _clean_code_snippet(code)

        if language.lower() != "python":
            result = {
                "success": False,
                "stdout": "",
                "stderr": f"Unsupported language: {language}",
                "return_code": 1,
            }
            logger.error(f"Execution failed:\n{result}")
            return result

        tmp = None
        try:
            # Write the sanitized code to a temporary file
            tmp = tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False)
            tmp.write(sanitized)
            tmp.flush()
            tmp_path = tmp.name
            tmp.close()

            # Execute the Python file
            proc = subprocess.run(
                [self.python_executable, tmp_path],
                capture_output=True,
                text=True,
            )

            success = proc.returncode == 0
            result = {
                "success": success,
                "stdout": proc.stdout,
                "stderr": proc.stderr,
                "return_code": proc.returncode,
            }

            if not success:
                # Mirror the existing logging format observed in logs
                logger.error(
                    "Execution failed:\n{"
                    f"'success': {result['success']}, 'stdout': '{result['stdout']}', "
                    f"'stderr': 'Process exited with code {proc.returncode} with stdout:  and stderr: {proc.stderr}', "
                    f"'return_code': {result['return_code']}"
                    "}"
                )

            return result
        except Exception as e:
            result = {
                "success": False,
                "stdout": "",
                "stderr": str(e),
                "return_code": 1,
            }
            logger.error(f"Execution failed:\n{result}")
            return result
        finally:
            # Best-effort cleanup
            if tmp is not None:
                try:
                    os.unlink(tmp.name)
                except Exception:
                    pass
