import traceroot
from traceroot import observe
from openinference.instrumentation import using_attributes
import time

# 1. Initialize with your API Key
API_KEY = "tr-14143e3b-7ecb-46ad-9442-b85b6215a362"

traceroot.initialize(
    api_key=API_KEY,
    host_url="http://localhost:8000",
)

@observe(name="agent_interaction", type="agent")
def mock_agent_step(name):
    print(f"Executing {name}...")
    return f"Result for {name}"

# 2. Send traces sharing a session_id
print("Step 1: Sending session-linked traces...")
with using_attributes(session_id="verify-session-999"):
    mock_agent_step("Thought process")
    mock_agent_step("Tool execution")

# 3. Send a separate trace
print("Step 2: Sending independent trace...")
mock_agent_step("Standalone action")

traceroot.flush()
print("Done! Check your UI at http://localhost:3000")
