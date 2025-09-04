import os
import time

from dotenv import load_dotenv

import traceroot

# ---- Traceroot Setup ----
load_dotenv()  # load from .env
traceroot.init()  # use global parameters (from env)
traceroot.init(
    service_name="override-service",
    environment="override-env",
    github_owner="override-owner",
    github_repo_name="override-repo",
    github_commit_hash="override-commit",
    token=os.getenv("TRACEROOT_TOKEN"),
    enable_span_cloud_export=True,
    enable_log_cloud_export=False,
)

logger = traceroot.get_logger()


@traceroot.trace()
def logging_function_2():
    logger.info("This is an info message 2")
    logger.warning("This is a warning message 2")
    logger.error("This is an error message 2")


@traceroot.trace()
def logging_function():
    logger.info("This is an info message")
    logger.warning("This is a warning message")
    logger.error("This is an error message")
    logging_function_2()


@traceroot.trace()
def main():
    logger.debug("Main function started")
    time.sleep(1)
    logging_function()
    logger.debug("Main function completed")


if __name__ == "__main__":
    logger.info("Starting loop example - main function will run every 60 seconds")
    logger.info("Press Ctrl+C to stop the loop")

    try:
        while True:
            main()
            logger.info("Waiting 60 seconds before next execution...")
            time.sleep(60)
    except KeyboardInterrupt:
        logger.info("Loop stopped by user")
        print("\nLoop stopped.")
