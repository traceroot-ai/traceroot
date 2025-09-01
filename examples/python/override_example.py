import os
import time

import traceroot

# Initialize traceroot with override parameters, which will
# override the parameters in the .traceroot-config.yaml file
token = os.getenv("TRACEROOT_TOKEN")

traceroot.init(
    service_name="override-service",
    environment="override-env",
    github_owner="override-owner",
    github_repo_name="override-repo",
    github_commit_hash="override-commit",
    token=token,
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
    main()
