import time

import traceroot
from dotenv import find_dotenv, load_dotenv

# Initialize traceroot with override parameters, which will
# override the parameters in the .traceroot-config.yaml file
verification_endpoint = "http://localhost:8000/v1/verify/credentials"

# ----------------- load .env -----------------
dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print(
        "No .env file found (find_dotenv returned None).\n"
        "Using process environment variables."
    )

traceroot.init()

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
