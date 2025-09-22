diff --git a/examples/multi_code_agent_v2/rest/main.py b/examples/multi_code_agent_v2/rest/main.py
index abcdef1..abcdef2 100644
--- a/examples/multi_code_agent_v2/rest/main.py
+++ b/examples/multi_code_agent_v2/rest/main.py
@@ -219,13 +219,20 @@ class MultiAgentSystem:
     def should_retry(self, attempt, exception):
-        self.logger.error(f"Execution failed on attempt {attempt}. Retrying...")
-        return attempt < self.max_retries
+        # Do not retry on syntax errors in generated code
+        if isinstance(exception, SyntaxError):
+            self.logger.error(f"SyntaxError encountered: {exception}. Not retrying.")
+            return False
+
+        # Other exceptions may be retried up to max_retries
+        self.logger.error(f"Execution failed on attempt {attempt}: {exception}. Retrying...")
+        return attempt < self.max_retries
 
     def run(self, *args, **kwargs):
         # ... rest of the implementation ...
         while True:
             try:
-                result = self.execution_agent.execute_code(code)
+                result = self.execution_agent.execute_code(code)
                 break
             except Exception as e:
-                if not self.should_retry(attempt):
+                if not self.should_retry(attempt, e):
                     raise
+                attempt += 1
+                continue
 
         return result
